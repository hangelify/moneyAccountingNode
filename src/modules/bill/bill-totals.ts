export const BILL_ITEM_TOLERANCE = Symbol('BILL_ITEM_TOLERANCE');

export const DEFAULT_BILL_ITEM_TOLERANCE = 0.01;

/**
 * How far, per item, the items of a bill may add up away from its total
 * before the bill is flagged with `amount_mismatch`.
 */
export function readBillItemTolerance(): number {
  const raw = process.env.BILL_ITEM_TOLERANCE?.trim();
  if (!raw) return DEFAULT_BILL_ITEM_TOLERANCE;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(
      `BILL_ITEM_TOLERANCE must be an amount >= 0 with at most two decimals, got "${raw}"`,
    );
  }
  return Number(raw);
}

const toCents = (v: number | string) => Math.round(Number(v) * 100);

/**
 * True when the items differ from the bill total by more than
 * `tolerancePerItem` x item count. Compared in integer cents.
 */
export function isAmountMismatch(
  total: number | string,
  items: (number | string)[],
  tolerancePerItem: number,
): boolean {
  const itemsCents = items.reduce<number>((sum, a) => sum + toCents(a), 0);
  const allowed = toCents(tolerancePerItem) * items.length;
  return Math.abs(toCents(total) - itemsCents) > allowed;
}
