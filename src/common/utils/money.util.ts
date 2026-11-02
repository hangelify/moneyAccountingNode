/**
 * Upper bound for any money amount accepted by the API. Columns are
 * decimal(19,2); this keeps cents exact in a JS number and leaves room for sums.
 */
export const MAX_MONEY_AMOUNT = 1e12;

/** Adds two money amounts in integer cents, so 0.1 + 0.2 is exactly 0.3. */
export function addMoney(a: number, b: number): number {
  return (Math.round(a * 100) + Math.round(b * 100)) / 100;
}
