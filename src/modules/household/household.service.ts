import {
  Inject,
  Injectable,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  GoneException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager, LockMode } from '@mikro-orm/core';
import { createHash, randomBytes } from 'crypto';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { HouseholdInvite } from '../../entities/household-invite.entity';
import { User } from '../../entities/user.entity';
import type { HouseholdContext } from './guards/household-member.guard';
import { CreateHouseholdDto } from './dto/create-household.dto';
import { UpdateHouseholdDto } from './dto/update-household.dto';
import { UpdateMyHouseholdDto } from './dto/update-my-household.dto';
import { CreateInviteDto } from './dto/create-invite.dto';
import {
  HouseholdResponseDto,
  HouseholdDetailResponseDto,
  HouseholdMemberDto,
  InviteListItemDto,
  InviteResponseDto,
} from './dto/household-response.dto';
import { normalizeEmail } from '../../common/transforms/normalize-email';
import { HOUSEHOLD_LIMITS, type HouseholdLimits } from './household-limits.env';
import { countLiveMemberships, lockUserHouseholds } from './household-locks';
// Not the '../category' barrel: category.controller imports '../household'.
import { CategoryDefaultsService } from '../category/category-defaults.service';

@Injectable()
export class HouseholdService {
  private readonly frontendUrl: string;

  constructor(
    @InjectRepository(HouseholdMember)
    private readonly memberRepo: EntityRepository<HouseholdMember>,
    private readonly em: EntityManager,
    @Inject(HOUSEHOLD_LIMITS) private readonly limits: HouseholdLimits,
    private readonly categoryDefaults: CategoryDefaultsService,
  ) {
    const url = process.env['FRONTEND_URL'];
    if (!url)
      throw new Error('Required environment variable FRONTEND_URL is not set');
    this.frontendUrl = url;
  }

  assertOwner(ctx: HouseholdContext): void {
    if (ctx.role !== 'owner') {
      throw new ForbiddenException(
        'Only the household owner can perform this action',
      );
    }
  }

  async createHousehold(
    userId: string,
    dto: CreateHouseholdDto,
  ): Promise<HouseholdResponseDto> {
    const household = await this.em.transactional(async (txEm) => {
      await this.assertBelowHouseholdLimit(txEm, userId);
      const created = new Household();
      created.name = dto.name;
      created.created_by = txEm.getReference(User, userId);
      created.currency =
        dto.currency ?? (await txEm.findOneOrFail(User, userId)).currency;

      const member = new HouseholdMember();
      member.household = created;
      member.user = txEm.getReference(User, userId);
      member.role = 'owner';

      txEm.persist(created);
      txEm.persist(member);
      await txEm.flush();
      // A household is never left without its categories: a failed seed
      // rolls the household back.
      await this.categoryDefaults.seedForHousehold(created.id, txEm);
      return created;
    });

    return this.toDto(household, 1);
  }

  async listHouseholds(userId: string): Promise<HouseholdResponseDto[]> {
    const memberships = await this.memberRepo.find(
      { user: { id: userId }, household: { deleted_at: null } },
      { populate: ['household', 'household.members'] },
    );
    return memberships.map((m) =>
      this.toDto(
        m.household,
        m.household.members.getItems().length,
        m.display_name,
      ),
    );
  }

  async getHousehold(
    hid: string,
    userId: string,
  ): Promise<HouseholdDetailResponseDto> {
    const household = await this.em.findOne(
      Household,
      { id: hid, deleted_at: null },
      { populate: ['members.user'] },
    );
    if (!household) throw new NotFoundException(`Household ${hid} not found`);

    const members: HouseholdMemberDto[] = household.members
      .getItems()
      .map((m) => ({
        user_id: m.user.id,
        email: m.user.email,
        first_name: m.user.first_name,
        last_name: m.user.last_name,
        role: m.role,
        joined_at: m.joined_at,
      }));

    const mine = household.members.getItems().find((m) => m.user.id === userId);
    return {
      ...this.toDto(household, members.length, mine?.display_name),
      members,
    };
  }

  async updateHousehold(
    hid: string,
    userId: string,
    dto: UpdateHouseholdDto,
  ): Promise<HouseholdResponseDto> {
    if (dto.name === undefined && dto.currency === undefined) {
      throw new BadRequestException('Nothing to update');
    }
    const household = await this.em.findOne(Household, {
      id: hid,
      deleted_at: null,
    });
    if (!household) throw new NotFoundException(`Household ${hid} not found`);
    if (dto.name !== undefined) household.name = dto.name;
    if (dto.currency !== undefined) household.currency = dto.currency;
    await this.em.persist(household).flush();
    return this.toResponse(household, userId);
  }

  /** Sets (or, with null, clears) the caller's own name for the household. */
  async updateMyHousehold(
    hid: string,
    userId: string,
    dto: UpdateMyHouseholdDto,
  ): Promise<HouseholdResponseDto> {
    const household = await this.em.findOne(Household, {
      id: hid,
      deleted_at: null,
    });
    if (!household) throw new NotFoundException(`Household ${hid} not found`);
    // Through the entity, not nativeUpdate: the guard has already loaded
    // this membership, and the response is built from that loaded copy.
    const mine = await this.memberRepo.findOneOrFail({
      household: { id: hid },
      user: { id: userId },
    });
    mine.display_name = dto.display_name;
    await this.em.flush();
    return this.toResponse(household, userId);
  }

  private async toResponse(
    household: Household,
    userId: string,
  ): Promise<HouseholdResponseDto> {
    const members = await this.memberRepo.find({
      household: { id: household.id },
    });
    const mine = members.find((m) => m.user.id === userId);
    return this.toDto(household, members.length, mine?.display_name);
  }

  /**
   * Soft-deletes a household of `ownerId`. Refused while anyone else is a
   * member (HAN-145 will give them a copy) and when it is the owner's last
   * live household.
   */
  async softDeleteHousehold(hid: string, ownerId: string): Promise<void> {
    await this.em.transactional(async (txEm) => {
      await lockUserHouseholds(txEm, ownerId);
      // FOR UPDATE waits for an invite being accepted into this household
      // (it holds FOR SHARE), so the member count below is final.
      const household = await txEm.findOne(
        Household,
        { id: hid, deleted_at: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!household) throw new NotFoundException(`Household ${hid} not found`);

      const members = await txEm.count(HouseholdMember, {
        household: { id: hid },
      });
      if (members > 1) {
        throw new ConflictException({
          message: 'Remove the other members before deleting this household',
          reason: 'household_has_members',
        });
      }
      if ((await countLiveMemberships(txEm, ownerId)) <= 1) {
        throw new ConflictException({
          message: 'The last household cannot be deleted',
          reason: 'last_household',
        });
      }
      household.deleted_at = new Date();
    });
  }

  // Invites are bound to an email address, so both ends must have proven
  // they own theirs.
  private assertEmailVerified(user: Pick<User, 'email_verified_at'>): void {
    if (!user.email_verified_at) {
      throw new ForbiddenException('Email address is not verified');
    }
  }

  async createInvite(
    hid: string,
    inviter: Pick<User, 'id' | 'email_verified_at'>,
    dto: CreateInviteDto,
  ): Promise<InviteResponseDto> {
    this.assertEmailVerified(inviter);
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.em.transactional(async (txEm) => {
      // Locking the household serializes invite creation, so concurrent
      // requests cannot overshoot the active invite limit.
      const household = await txEm.findOne(
        Household,
        { id: hid, deleted_at: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!household) throw new NotFoundException(`Household ${hid} not found`);

      const active = await txEm.count(HouseholdInvite, {
        household: { id: hid },
        status: 'pending',
        expires_at: { $gt: new Date() },
      });
      if (active >= this.limits.maxActiveInvites) {
        throw new ConflictException(
          `A household can have at most ${this.limits.maxActiveInvites} active invites; revoke one first`,
        );
      }

      const invite = new HouseholdInvite();
      invite.household = household;
      invite.invited_by = txEm.getReference(User, inviter.id);
      invite.invitee_email = normalizeEmail(dto.email);
      invite.token_hash = tokenHash;
      invite.expires_at = expiresAt;
      txEm.persist(invite);
    });

    return {
      token: rawToken,
      invite_url: `${this.frontendUrl}/invite/${rawToken}`,
      expires_at: expiresAt,
    };
  }

  async listInvites(hid: string): Promise<InviteListItemDto[]> {
    const invites = await this.em.find(
      HouseholdInvite,
      { household: { id: hid } },
      { orderBy: { created_at: 'desc', id: 'desc' } },
    );
    const now = new Date();
    return invites.map((i) => ({
      id: i.id,
      invitee_email: i.invitee_email,
      status:
        i.status === 'pending' && i.expires_at <= now ? 'expired' : i.status,
      expires_at: i.expires_at,
      created_at: i.created_at,
    }));
  }

  /** Revokes a pending invite. Revoking a revoked invite is a no-op. */
  async revokeInvite(hid: string, inviteId: string): Promise<void> {
    // A concurrent accept holds the row lock; this update waits for it and
    // then no longer matches, so an accepted invite is never revoked.
    const revoked = await this.em.nativeUpdate(
      HouseholdInvite,
      { id: inviteId, household: { id: hid }, status: 'pending' },
      { status: 'revoked' },
    );
    if (revoked > 0) return;

    const invite = await this.em.findOne(HouseholdInvite, {
      id: inviteId,
      household: { id: hid },
    });
    if (!invite) throw new NotFoundException(`Invite ${inviteId} not found`);
    if (invite.status === 'accepted') {
      throw new ConflictException('An accepted invite cannot be revoked');
    }
  }

  async acceptInvite(
    rawToken: string,
    user: Pick<User, 'id' | 'email' | 'email_verified_at'>,
  ): Promise<void> {
    this.assertEmailVerified(user);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    await this.em.transactional(async (txEm) => {
      const lockedInvite = await txEm.findOne(
        HouseholdInvite,
        { token_hash: tokenHash },
        // Locks the invite row only: populating the household here would join
        // it into the FOR UPDATE and block every write into that household.
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!lockedInvite) throw new GoneException({ reason: 'not_found' });
      // Checked first: a holder of someone else's link learns nothing more.
      if (lockedInvite.invitee_email !== normalizeEmail(user.email)) {
        throw new ForbiddenException(
          'This invite was issued to a different email address',
        );
      }
      await txEm.populate(lockedInvite, ['household']);
      if (lockedInvite.household.deleted_at)
        throw new GoneException({ reason: 'household_deleted' });
      if (lockedInvite.status === 'revoked')
        throw new GoneException({ reason: 'revoked' });

      const existing = await txEm.findOne(HouseholdMember, {
        household: { id: lockedInvite.household.id },
        user: { id: user.id },
      });
      if (existing) throw this.alreadyMember();

      if (lockedInvite.status === 'accepted')
        throw new GoneException({ reason: 'already_accepted' });
      if (lockedInvite.expires_at <= new Date())
        throw new GoneException({ reason: 'expired' });

      await this.assertBelowHouseholdLimit(txEm, user.id);

      // FOR SHARE: a concurrent delete (FOR UPDATE) either waits for this
      // join and then sees the new member, or wins and this join is refused.
      // It does not conflict with the FOR KEY SHARE of bill inserts.
      const live = (await txEm
        .getConnection()
        .execute(
          'select 1 from "households" where "id" = ? and "deleted_at" is null for share',
          [lockedInvite.household.id],
          'all',
          txEm.getTransactionContext(),
        )) as unknown[];
      if (live.length === 0)
        throw new GoneException({ reason: 'household_deleted' });

      // Another invite of this user to the same household may be accepted
      // concurrently: the loser inserts nothing and leaves its invite unspent.
      const inserted = await (txEm
        .getConnection()
        .execute(
          'insert into "household_members" ("household_id", "user_id", "role") values (?, ?, ?) on conflict do nothing returning 1',
          [lockedInvite.household.id, user.id, 'member'],
          'all',
          txEm.getTransactionContext(),
        ) as Promise<unknown[]>);
      if (inserted.length === 0) throw this.alreadyMember();

      lockedInvite.status = 'accepted';
      txEm.persist(lockedInvite);
    });
  }

  /**
   * Locks the user's household count for the rest of `txEm`'s transaction
   * and refuses one more household at the limit.
   */
  private async assertBelowHouseholdLimit(
    txEm: EntityManager,
    userId: string,
  ): Promise<void> {
    await lockUserHouseholds(txEm, userId);
    const count = await countLiveMemberships(txEm, userId);
    if (count >= this.limits.maxHouseholds) {
      throw new ConflictException({
        message: `A user can belong to at most ${String(this.limits.maxHouseholds)} households`,
        reason: 'household_limit',
      });
    }
  }

  private alreadyMember(): ConflictException {
    return new ConflictException({
      message: 'You are already a member of this household',
      reason: 'already_member',
    });
  }

  async removeMember(
    hid: string,
    requesterId: string,
    targetUserId: string,
  ): Promise<void> {
    const requester = await this.memberRepo.findOne({
      household: { id: hid },
      user: { id: requesterId },
    });
    if (!requester) throw new ForbiddenException();

    if (requester.role !== 'owner' && requesterId !== targetUserId) {
      throw new ForbiddenException('Members can only remove themselves');
    }

    if (requester.role === 'owner' && requesterId === targetUserId) {
      await this.em.transactional(async (txEm) => {
        const owners = await txEm.find(
          HouseholdMember,
          { household: { id: hid }, role: 'owner' },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (owners.length <= 1) {
          throw new ConflictException(
            'Cannot remove the last owner of a household',
          );
        }
        await txEm.nativeDelete(HouseholdMember, {
          household: { id: hid },
          user: { id: targetUserId },
        });
      });
      return;
    }

    const target = await this.memberRepo.findOne({
      household: { id: hid },
      user: { id: targetUserId },
    });
    if (!target)
      throw new NotFoundException(
        `User ${targetUserId} is not a member of this household`,
      );

    await this.em.nativeDelete(HouseholdMember, {
      household: { id: hid },
      user: { id: targetUserId },
    });
  }

  private toDto(
    h: Household,
    memberCount: number,
    displayName?: string | null,
  ): HouseholdResponseDto {
    return {
      id: h.id,
      name: displayName ?? h.name,
      original_name: h.name,
      currency: h.currency,
      created_at: h.created_at,
      member_count: memberCount,
    };
  }
}
