import { NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { LimitPeriodType } from '../../types/limit-period-type.enum';

// "Do not carry over" marks of category limits (HAN-25), written in the
// caller's transaction.

const rows = (
  tx: EntityManager,
  sql: string,
  params: unknown[],
): Promise<{ id: string }[]> =>
  tx
    .getConnection()
    .execute(sql, params, 'all', tx.getTransactionContext()) as Promise<
    { id: string }[]
  >;

/** One "do not carry over" mark: a category's period of a type. */
export interface CarryStopKey {
  householdId: string;
  categoryId: string;
  periodType: LimitPeriodType;
  /** `YYYY-MM-DD`, the first day of the period. */
  periodStart: string;
}

/** Marks the period "do not carry over" in `tx`; a no-op when marked. */
export async function insertCarryStop(
  tx: EntityManager,
  key: CarryStopKey,
  userId: string | null,
): Promise<void> {
  await tx.getConnection().execute(
    `INSERT INTO category_limit_carry_stops
         (household_id, category_id, period_type, period_start, created_by_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (category_id, period_type, period_start) DO NOTHING`,
    [key.householdId, key.categoryId, key.periodType, key.periodStart, userId],
    'run',
    tx.getTransactionContext(),
  );
}

/**
 * 404 unless the category is in the household (archived or not) and has a
 * version of the type in force on the period start.
 */
export async function assertLimitAt(
  tx: EntityManager,
  key: CarryStopKey,
): Promise<void> {
  const [category] = await rows(
    tx,
    `SELECT id FROM categories WHERE id = ? AND household_id = ?`,
    [key.categoryId, key.householdId],
  );
  if (!category) {
    throw new NotFoundException(`Category with ID ${key.categoryId} not found`);
  }
  // Versions start and end on period starts of their type, so the one in
  // force on the first day is in force the whole period.
  const [version] = await rows(
    tx,
    `SELECT id FROM category_limits
     WHERE  category_id = ? AND period_type = ? AND effective_from <= ?
       AND  (effective_to IS NULL OR effective_to > ?)
     LIMIT  1`,
    [key.categoryId, key.periodType, key.periodStart, key.periodStart],
  );
  if (!version) {
    throw new NotFoundException(
      `Category with ID ${key.categoryId} has no ${key.periodType} limit on ${key.periodStart}`,
    );
  }
}

/** Removes the "do not carry over" mark; a no-op when there is none. */
export async function deleteCarryStop(
  tx: EntityManager,
  key: CarryStopKey,
): Promise<void> {
  await tx.getConnection().execute(
    `DELETE FROM category_limit_carry_stops
       WHERE  category_id = ? AND period_type = ? AND period_start = ?`,
    [key.categoryId, key.periodType, key.periodStart],
    'run',
    tx.getTransactionContext(),
  );
}
