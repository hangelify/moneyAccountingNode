import { Currency } from '../../types/currency.enum';
import { LimitPeriodType } from '../../types/limit-period-type.enum';
import {
  limitPeriodEnd,
  limitPeriodStart,
} from '../../common/utils/period-range';

export interface LimitVersion {
  id: string;
  period_type: LimitPeriodType;
  amount: number;
  currency: Currency;
  effective_from: string;
  effective_to: string | null;
}

export type LimitChange =
  | {
      kind: 'set';
      period_type: LimitPeriodType;
      amount: number;
      currency: Currency;
    }
  | { kind: 'remove' };

export interface LimitPlan {
  delete: string[];
  update: { id: string; effective_to: string }[];
  insert: Omit<LimitVersion, 'id'> | null;
  /** Nothing to write: a `set` equal to the open version starting at S. */
  unchanged: boolean;
}

const UNCHANGED: LimitPlan = {
  delete: [],
  update: [],
  insert: null,
  unchanged: true,
};

/**
 * Pure planner for a limit change; the service applies the plan in a locked
 * transaction. `versions`: the category's versions with `effective_to` null or
 * after the change's start; older ones are history and are ignored.
 */
export function planLimitChange(
  versions: LimitVersion[],
  change: LimitChange,
  today: string,
): LimitPlan {
  const open = versions.find((x) => x.effective_to === null);

  if (change.kind === 'remove') {
    if (!open) return { ...UNCHANGED, delete: [], update: [] };
    return {
      delete: [],
      update: [
        { id: open.id, effective_to: limitPeriodEnd(open.period_type, today) },
      ],
      insert: null,
      unchanged: false,
    };
  }

  const start = limitPeriodStart(change.period_type, today);
  if (
    open?.period_type === change.period_type &&
    open.amount === change.amount &&
    open.currency === change.currency &&
    open.effective_from === start
  ) {
    return { ...UNCHANGED, delete: [], update: [] };
  }

  return {
    delete: versions.filter((x) => x.effective_from >= start).map((x) => x.id),
    update: versions
      .filter(
        (x) =>
          x.effective_from < start &&
          (x.effective_to === null || x.effective_to > start),
      )
      .map((x) => ({ id: x.id, effective_to: start })),
    insert: {
      period_type: change.period_type,
      amount: change.amount,
      currency: change.currency,
      effective_from: start,
      effective_to: null,
    },
    unchanged: false,
  };
}
