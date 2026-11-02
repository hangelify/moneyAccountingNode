import { Currency } from '../../types/currency.enum';
import {
  rankCandidates,
  type CandidateRow,
  type DuplicateProbe,
} from './bill-duplicates';

const probe: DuplicateProbe = {
  amount: 100,
  currency: Currency.MDL,
  bill_date: '2026-10-03',
  market_id: null,
  market_name: 'Linella',
  fiscal_register_id: null,
  fiscal_receipt_number: null,
  purchase_time: null,
};

let seq = 0;
const row = (over: Partial<CandidateRow> = {}): CandidateRow => ({
  ...probe,
  id: `row-${++seq}`,
  created_at: '2026-10-03T10:00:00.000000',
  created_by_name: 'Ana',
  ...over,
});

const opts = { dateToleranceDays: 0, limit: 5 };
const matches = (p: DuplicateProbe, rows: CandidateRow[], o = opts) =>
  rankCandidates(p, rows, o).map((r) => r.match);

describe('rankCandidates', () => {
  it('ranks fiscal over strong over weak', () => {
    const fiscalProbe = {
      ...probe,
      fiscal_register_id: 'J4030',
      fiscal_receipt_number: '0042',
    };
    const weak = row({ market_name: 'Other' });
    const strong = row();
    const fiscal = row({
      amount: 55,
      fiscal_register_id: 'J4030',
      fiscal_receipt_number: '0042',
    });
    const ranked = rankCandidates(fiscalProbe, [weak, strong, fiscal], opts);
    expect(ranked.map((r) => r.match)).toEqual(['fiscal', 'strong', 'weak']);
    expect(ranked[0].row.id).toBe(fiscal.id);
  });

  it('never matches different receipt numbers on the same register', () => {
    const p = {
      ...probe,
      fiscal_register_id: 'J4030',
      fiscal_receipt_number: '0042',
    };
    const r = row({
      fiscal_register_id: 'J4030',
      fiscal_receipt_number: '0043',
    });
    expect(matches(p, [r])).toEqual([]);
  });

  it('compares fiscal ids trimmed and case-insensitive', () => {
    const p = {
      ...probe,
      amount: 1,
      fiscal_register_id: ' J4030 ',
      fiscal_receipt_number: '0042',
    };
    const r = row({
      amount: 2,
      fiscal_register_id: 'j4030',
      fiscal_receipt_number: ' 0042',
    });
    expect(matches(p, [r])).toEqual(['fiscal']);
  });

  it('treats blank fiscal ids as null', () => {
    const p = {
      ...probe,
      fiscal_register_id: ' ',
      fiscal_receipt_number: ' ',
    };
    const r = row({
      amount: 2,
      fiscal_register_id: ' ',
      fiscal_receipt_number: ' ',
    });
    expect(matches(p, [r])).toEqual([]);
  });

  it('matches 10.50 and 10.5', () => {
    expect(
      matches({ ...probe, amount: 10.5, market_name: null }, [
        row({ amount: Number('10.50'), market_name: null }),
      ]),
    ).toEqual(['weak']);
  });

  it('treats market names case- and space-insensitively', () => {
    expect(
      matches({ ...probe, market_name: 'LINELLA ' }, [
        row({ market_name: 'Linella' }),
      ]),
    ).toEqual(['strong']);
  });

  it('is strong on the same market id', () => {
    expect(
      matches({ ...probe, market_id: 'm1', market_name: 'A' }, [
        row({ market_id: 'm1', market_name: 'B' }),
      ]),
    ).toEqual(['strong']);
  });

  it('is strong on the same purchase_time without a market', () => {
    const p = { ...probe, market_name: null, purchase_time: '14:05' };
    expect(
      matches(p, [row({ market_name: null, purchase_time: '14:05' })]),
    ).toEqual(['strong']);
  });

  it('matches two bills without a currency', () => {
    expect(
      matches({ ...probe, currency: null, market_name: null }, [
        row({ currency: null, market_name: null }),
      ]),
    ).toEqual(['weak']);
  });

  it('does not match different currencies or amounts', () => {
    expect(
      matches(probe, [
        row({ currency: Currency.EUR }),
        row({ currency: null }),
        row({ amount: 100.01 }),
      ]),
    ).toEqual([]);
  });

  it('respects date tolerance', () => {
    const r = row({ bill_date: '2026-10-04', market_name: null });
    const p = { ...probe, market_name: null };
    expect(matches(p, [r])).toEqual([]);
    expect(matches(p, [r], { dateToleranceDays: 1, limit: 5 })).toEqual([
      'weak',
    ]);
  });

  it('orders ties by closest date, then newest created_at', () => {
    const far = row({ bill_date: '2026-10-05', created_at: '2026-10-09' });
    const nearOld = row({ bill_date: '2026-10-04', created_at: '2026-10-01' });
    const nearNew = row({ bill_date: '2026-10-04', created_at: '2026-10-02' });
    const ids = rankCandidates(
      { ...probe, market_name: null },
      [far, nearOld, nearNew].map((r) => ({ ...r, market_name: null })),
      { dateToleranceDays: 2, limit: 5 },
    ).map((r) => r.row.id);
    expect(ids).toEqual([nearNew.id, nearOld.id, far.id]);
  });

  it('caps at limit', () => {
    const rows = [row(), row(), row()];
    expect(
      rankCandidates(probe, rows, { dateToleranceDays: 0, limit: 2 }),
    ).toHaveLength(2);
  });
});
