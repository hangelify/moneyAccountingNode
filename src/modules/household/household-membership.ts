import { EntityRepository } from '@mikro-orm/core';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';

/**
 * Role of the user in a household, or null when the household does not
 * exist, is deleted, or the user is not a member. Callers decide how to
 * report null (guard and bill move: 403).
 */
export async function findHouseholdRole(
  households: EntityRepository<Household>,
  members: EntityRepository<HouseholdMember>,
  householdId: string,
  userId: string,
): Promise<'owner' | 'member' | null> {
  const household = await households.findOne({
    id: householdId,
    deleted_at: null,
  });
  if (!household) return null;

  const member = await members.findOne({
    household: { id: householdId },
    user: { id: userId },
  });
  return member ? member.role : null;
}
