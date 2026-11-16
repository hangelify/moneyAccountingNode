import type { EntityManager } from '@mikro-orm/core';
import { HouseholdMember } from '../../entities/household-member.entity';

/**
 * Serializes, for one user, the writes that change how many live households
 * they belong to (create, accept an invite, delete): each counts and then
 * writes, so two at once could both pass the count. `em` must be inside a
 * transaction; the lock is released when it ends.
 */
export async function lockUserHouseholds(
  em: EntityManager,
  userId: string,
): Promise<void> {
  await em
    .getConnection()
    .execute(
      `select pg_advisory_xact_lock(hashtext('household-count:' || ?))`,
      [userId],
      'all',
      em.getTransactionContext(),
    );
}

/** Live (not deleted) households the user belongs to, any role. */
export function countLiveMemberships(
  em: EntityManager,
  userId: string,
): Promise<number> {
  return em.count(HouseholdMember, {
    user: { id: userId },
    household: { deleted_at: null },
  });
}
