import type { Currency } from '../../types/currency.enum';

export type DuplicateMatch = 'fiscal' | 'strong' | 'weak';

/** What a bill or a draft is compared on. `market_name` is the resolved name or the raw one. */
export interface DuplicateProbe {
  amount: number;
  currency: Currency | null;
  bill_date: string;
  market_id: string | null;
  market_name: string | null;
  fiscal_register_id: string | null;
  fiscal_receipt_number: string | null;
  purchase_time: string | null;
}

export interface CandidateRow extends DuplicateProbe {
  id: string;
  /** Only used to order ties. */
  created_at: string;
  created_by_name: string | null;
}

const RANK: Record<DuplicateMatch, number> = { fiscal: 0, strong: 1, weak: 2 };
const DAY_MS = 86_400_000;

/** Trimmed lower case; blank counts as absent. */
function normalize(v: string | null): string | null {
  const s = v?.trim().toLowerCase();
  return s ? s : null;
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

/** Whole days between two `YYYY-MM-DD` days, computed in UTC so no zone shifts it. */
function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;
}

function classify(
  probe: DuplicateProbe,
  row: CandidateRow,
  dateToleranceDays: number,
): DuplicateMatch | null {
  const pRegister = normalize(probe.fiscal_register_id);
  const rRegister = normalize(row.fiscal_register_id);
  const pReceipt = normalize(probe.fiscal_receipt_number);
  const rReceipt = normalize(row.fiscal_receipt_number);

  if (pRegister && pReceipt && rRegister && rReceipt) {
    if (pRegister === rRegister && pReceipt === rReceipt) return 'fiscal';
  }
  // Two receipts of the same register are two purchases.
  if (pRegister && pRegister === rRegister && pReceipt && rReceipt) {
    if (pReceipt !== rReceipt) return null;
  }

  if (cents(probe.amount) !== cents(row.amount)) return null;
  if (probe.currency !== row.currency) return null;
  if (dayDistance(probe.bill_date, row.bill_date) > dateToleranceDays) {
    return null;
  }

  const sameMarket =
    (probe.market_id !== null && probe.market_id === row.market_id) ||
    (normalize(probe.market_name) !== null &&
      normalize(probe.market_name) === normalize(row.market_name));
  const sameTime =
    probe.purchase_time !== null && probe.purchase_time === row.purchase_time;
  return sameMarket || sameTime ? 'strong' : 'weak';
}

/** Likely duplicates of `probe` among `rows`: fiscal, strong, weak, then closest date, then newest. */
export function rankCandidates(
  probe: DuplicateProbe,
  rows: CandidateRow[],
  opts: { dateToleranceDays: number; limit: number; fiscalOnly?: boolean },
): Array<{ row: CandidateRow; match: DuplicateMatch }> {
  const ranked: Array<{
    row: CandidateRow;
    match: DuplicateMatch;
    distance: number;
  }> = [];
  for (const row of rows) {
    const match = classify(probe, row, opts.dateToleranceDays);
    // Fiscal-only probes have no reliable date or total to rank by.
    if (match && (!opts.fiscalOnly || match === 'fiscal')) {
      ranked.push({
        row,
        match,
        distance: opts.fiscalOnly
          ? 0
          : dayDistance(probe.bill_date, row.bill_date),
      });
    }
  }
  ranked.sort(
    (a, b) =>
      RANK[a.match] - RANK[b.match] ||
      a.distance - b.distance ||
      (a.row.created_at < b.row.created_at
        ? 1
        : a.row.created_at > b.row.created_at
          ? -1
          : 0),
  );
  return ranked.slice(0, opts.limit).map(({ row, match }) => ({ row, match }));
}
