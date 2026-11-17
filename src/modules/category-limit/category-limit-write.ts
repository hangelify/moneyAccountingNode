import { ConflictException, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/core';
import { Category } from '../../entities/category.entity';
import { CategoryLimit } from '../../entities/category-limit.entity';
import { Household } from '../../entities/household.entity';
import { User } from '../../entities/user.entity';
import { LimitPeriodType } from '../../types/limit-period-type.enum';
import { decimalToNumber } from '../../common/utils/money.util';
import { limitPeriodStart } from '../../common/utils/period-range';
import { insertCarryStop } from './carry-stops';
import {
  LimitChange,
  LimitPlan,
  LimitVersion,
  planLimitChange,
} from './limit-versions';

/** What the caller asks for, before the household currency is known. */
export type CategoryLimitChange =
  | Omit<Extract<LimitChange, { kind: 'set' }>, 'currency'>
  | Extract<LimitChange, { kind: 'remove' }>;

export interface WriteCategoryLimitOptions {
  /** Author of an inserted version; null for system writes. */
  userId: string | null;
  /** `YYYY-MM-DD` day the change is made on. */
  today: string;
  /** No open version → `NotFoundException` (PUT, DELETE). */
  requireOpen?: boolean;
  /** An open version → `ConflictException` (POST). */
  forbidOpen?: boolean;
}

const toVersion = (row: CategoryLimit): LimitVersion => ({
  id: row.id,
  period_type: row.period_type,
  amount: decimalToNumber(row.amount),
  currency: row.currency,
  effective_from: row.effective_from,
  effective_to: row.effective_to,
});

const inForce = (rows: CategoryLimit[], today: string): CategoryLimit | null =>
  rows.find(
    (r) =>
      r.effective_from <= today &&
      (r.effective_to === null || r.effective_to > today),
  ) ?? null;

/** The live category of the household, locked FOR UPDATE; else 404. */
async function lockCategory(
  tx: EntityManager,
  householdId: string,
  categoryId: string,
): Promise<Category> {
  // Serialises every limit write of the category, so two requests never
  // plan from the same versions.
  const category = await tx.findOne(
    Category,
    { id: categoryId, household: { id: householdId }, deleted_at: null },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  );
  if (!category) {
    throw new NotFoundException(`Category with ID ${categoryId} not found`);
  }
  return category;
}

/** Every version a change made on `today` may touch, oldest first. */
function loadVersions(
  tx: EntityManager,
  categoryId: string,
  today: string,
): Promise<CategoryLimit[]> {
  // The earliest start any period type can give: older versions ended
  // before it and are history.
  const earliestStart = limitPeriodStart(LimitPeriodType.YEARLY, today);
  return tx.find(
    CategoryLimit,
    {
      category: categoryId,
      $or: [{ effective_to: null }, { effective_to: { $gt: earliestStart } }],
    },
    { orderBy: { effective_from: 'asc' }, refresh: true },
  );
}

/** `change` with the household currency read in this transaction. */
async function withCurrency(
  tx: EntityManager,
  householdId: string,
  change: CategoryLimitChange,
): Promise<LimitChange> {
  if (change.kind === 'remove') return change;
  const household = await tx.findOneOrFail(
    Household,
    { id: householdId },
    { refresh: true },
  );
  return { ...change, currency: household.currency };
}

/**
 * Writes the plan as delete, then close, then insert, flushing after each,
 * so the one-open-version index holds after every statement. Returns the
 * versions left, the inserted one last.
 */
async function applyPlan(
  tx: EntityManager,
  rows: CategoryLimit[],
  plan: LimitPlan,
  newRow: () => CategoryLimit,
): Promise<CategoryLimit[]> {
  const deleted = new Set(plan.delete);
  const kept = rows.filter((r) => !deleted.has(r.id));
  if (deleted.size > 0) {
    rows.filter((r) => deleted.has(r.id)).forEach((r) => tx.remove(r));
    await tx.flush();
  }
  if (plan.update.length > 0) {
    const closeAt = new Map(plan.update.map((u) => [u.id, u.effective_to]));
    for (const r of kept) r.effective_to = closeAt.get(r.id) ?? r.effective_to;
    await tx.flush();
  }
  if (!plan.insert) return kept;
  const inserted = Object.assign(newRow(), plan.insert);
  tx.persist(inserted);
  await tx.flush();
  return [...kept, inserted];
}

/**
 * Locks the category row (FOR UPDATE), plans and applies `change`; removing
 * the open limit also marks its current period "do not carry over". Must run
 * inside `tx`'s transaction; it neither forks nor opens one, so a caller can
 * combine it with its own writes. Returns the version in force today after
 * the write, or null.
 */
// eslint-disable-next-line max-params -- сигнатура задана планом HAN-24 (Task 6 вызывает её из CategoryService)
export async function writeCategoryLimit(
  tx: EntityManager,
  householdId: string,
  categoryId: string,
  change: CategoryLimitChange,
  opts: WriteCategoryLimitOptions,
): Promise<CategoryLimit | null> {
  const category = await lockCategory(tx, householdId, categoryId);
  const rows = await loadVersions(tx, categoryId, opts.today);

  const open = rows.find((r) => r.effective_to === null);
  if (opts.forbidOpen && open) {
    throw new ConflictException(
      `Category with ID ${categoryId} already has a limit`,
    );
  }
  if (opts.requireOpen && !open) {
    throw new NotFoundException(`Category with ID ${categoryId} has no limit`);
  }

  const full = await withCurrency(tx, householdId, change);
  const plan = planLimitChange(rows.map(toVersion), full, opts.today);
  if (plan.unchanged) return inForce(rows, opts.today);

  const after = await applyPlan(tx, rows, plan, () =>
    Object.assign(new CategoryLimit(), {
      household: tx.getReference(Household, householdId),
      category,
      created_by: opts.userId ? tx.getReference(User, opts.userId) : null,
    }),
  );
  // A removed limit's balance stops with its last period, so a limit
  // recreated right after it starts from zero (HAN-25).
  if (change.kind === 'remove' && open) {
    await insertCarryStop(
      tx,
      {
        householdId,
        categoryId,
        periodType: open.period_type,
        periodStart: limitPeriodStart(open.period_type, opts.today),
      },
      opts.userId,
    );
  }
  return inForce(after, opts.today);
}
