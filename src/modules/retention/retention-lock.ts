import { EntityManager } from '@mikro-orm/core';

export type ExclusiveResult<T> = { ran: true; result: T } | { ran: false };

/**
 * Runs `fn` in a transaction holding the advisory lock `retention:<name>`,
 * or not at all when another instance holds it. The lock is released with
 * the transaction.
 */
export async function runExclusive<T>(
  em: EntityManager,
  name: string,
  fn: (tx: EntityManager) => Promise<T>,
): Promise<ExclusiveResult<T>> {
  return em.fork().transactional(async (tx): Promise<ExclusiveResult<T>> => {
    const rows = (await tx
      .getConnection()
      .execute(
        'select pg_try_advisory_xact_lock(hashtext(?)) as locked',
        [`retention:${name}`],
        'all',
        tx.getTransactionContext(),
      )) as Array<{ locked: boolean }>;
    if (!rows[0]?.locked) return { ran: false };
    return { ran: true, result: await fn(tx) };
  });
}
