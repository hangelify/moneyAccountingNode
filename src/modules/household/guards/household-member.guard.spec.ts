/* eslint-disable @typescript-eslint/unbound-method */
import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { EntityRepository } from '@mikro-orm/core';
import { HouseholdMemberGuard } from './household-member.guard';
import { Household } from '../../../entities/household.entity';
import { HouseholdMember } from '../../../entities/household-member.entity';

function makeGuard() {
  const householdRepo = {
    findOne: jest.fn(),
  } as unknown as EntityRepository<Household>;
  const memberRepo = {
    findOne: jest.fn(),
  } as unknown as EntityRepository<HouseholdMember>;
  return {
    guard: new HouseholdMemberGuard(householdRepo, memberRepo),
    householdRepo,
    memberRepo,
  };
}

function makeCtx(userId: string, hid?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: { id: userId },
        params: hid ? { hid } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

const HID = '11111111-1111-4111-8111-111111111111';

describe('HouseholdMemberGuard', () => {
  it('throws BadRequestException when hid is missing', async () => {
    const { guard } = makeGuard();
    await expect(guard.canActivate(makeCtx('user-1'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws ForbiddenException, as for a non-member, without querying the DB when hid is not a UUID', async () => {
    const { guard, householdRepo, memberRepo } = makeGuard();
    await expect(
      guard.canActivate(makeCtx('user-1', 'not-a-uuid')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(householdRepo.findOne).not.toHaveBeenCalled();
    expect(memberRepo.findOne).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException when household not found or deleted', async () => {
    const { guard, householdRepo } = makeGuard();
    (householdRepo.findOne as jest.Mock).mockResolvedValue(null);
    await expect(
      guard.canActivate(makeCtx('user-1', HID)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws ForbiddenException when user is not a member', async () => {
    const { guard, householdRepo, memberRepo } = makeGuard();
    (householdRepo.findOne as jest.Mock).mockResolvedValue({ id: HID });
    (memberRepo.findOne as jest.Mock).mockResolvedValue(null);
    await expect(
      guard.canActivate(makeCtx('user-1', HID)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns true and attaches household context when user is a member', async () => {
    const { guard, householdRepo, memberRepo } = makeGuard();
    (householdRepo.findOne as jest.Mock).mockResolvedValue({ id: HID });
    (memberRepo.findOne as jest.Mock).mockResolvedValue({ role: 'owner' });
    const request: Record<string, unknown> = {
      user: { id: 'user-1' },
      params: { hid: HID },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(request.household).toEqual({ householdId: HID, role: 'owner' });
  });
});
