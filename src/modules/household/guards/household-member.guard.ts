import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { isUUID } from 'class-validator';
import { Household } from '../../../entities/household.entity';
import { HouseholdMember } from '../../../entities/household-member.entity';
import type { AuthenticatedUser } from '../../auth/types/jwt-payload.interface';

export interface HouseholdContext {
  householdId: string;
  role: 'owner' | 'member';
}

@Injectable()
export class HouseholdMemberGuard implements CanActivate {
  constructor(
    @InjectRepository(Household)
    private readonly householdRepo: EntityRepository<Household>,
    @InjectRepository(HouseholdMember)
    private readonly memberRepo: EntityRepository<HouseholdMember>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user: AuthenticatedUser;
      params: Record<string, string>;
      household?: HouseholdContext;
    }>();

    const hid = request.params?.hid;
    if (!hid) {
      throw new BadRequestException('Missing household ID in route params');
    }
    // Same answer as for a household the user is not a member of: the
    // response must not tell malformed ids from foreign ones.
    if (!isUUID(hid)) throw new ForbiddenException();

    const household = await this.householdRepo.findOne({
      id: hid,
      deleted_at: null,
    });
    if (!household) throw new ForbiddenException();

    const member = await this.memberRepo.findOne({
      household: { id: hid },
      user: { id: request.user.id },
    });
    if (!member) throw new ForbiddenException();

    request.household = { householdId: hid, role: member.role };
    return true;
  }
}
