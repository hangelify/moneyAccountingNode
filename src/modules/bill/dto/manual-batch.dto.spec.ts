import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { ManualBatchDto, MAX_MANUAL_BATCH_ROWS } from './manual-batch.dto';

const row = (over: Record<string, unknown> = {}) => ({
  bill_date: '2026-11-09',
  amount: 1.5,
  category_id: randomUUID(),
  ...over,
});

const build = (over: Record<string, unknown> = {}) =>
  plainToInstance(ManualBatchDto, {
    client_batch_id: randomUUID(),
    rows: [row()],
    ...over,
  });

/** `path.constraint` of every error, nested rows included. */
function failures(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    return [
      ...Object.keys(e.constraints ?? {}).map((c) => `${path}.${c}`),
      ...failures(e.children ?? [], path),
    ];
  });
}

const failuresOf = (over: Record<string, unknown> = {}) =>
  failures(validateSync(build(over)));
const rowFailures = (r: Record<string, unknown>) =>
  failuresOf({ rows: [row(r)] });

describe('ManualBatchDto', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-11-09T12:00:00Z')),
  );
  afterEach(() => jest.useRealTimers());

  it('accepts a minimal row and every optional field', () => {
    expect(failuresOf()).toEqual([]);
    expect(
      rowFailures({
        sub_category_id: randomUUID(),
        note: 'coffee',
        market_name: 'Kiosk',
        currency: 'EUR',
      }),
    ).toEqual([]);
    expect(rowFailures({ market_id: randomUUID() })).toEqual([]);
  });

  it('allows a date up to tomorrow and no lower bound', () => {
    expect(rowFailures({ bill_date: '2026-11-10' })).toEqual([]);
    expect(rowFailures({ bill_date: '2020-01-01' })).toEqual([]);
    expect(rowFailures({ bill_date: '2026-11-11' })).toEqual([
      'rows.0.bill_date.notAfterTomorrow',
    ]);
    expect(rowFailures({ bill_date: '2026-02-30' })).toContain(
      'rows.0.bill_date.isCalendarDate',
    );
  });

  it('takes 1 to 50 rows', () => {
    expect(failuresOf({ rows: [] })).toEqual(['rows.arrayMinSize']);
    const many = Array.from({ length: MAX_MANUAL_BATCH_ROWS + 1 }, () => row());
    expect(failuresOf({ rows: many })).toEqual(['rows.arrayMaxSize']);
    expect(failuresOf({ rows: many.slice(0, MAX_MANUAL_BATCH_ROWS) })).toEqual(
      [],
    );
  });

  it('wants a positive amount with at most 2 decimals', () => {
    expect(rowFailures({ amount: 0 })).toEqual(['rows.0.amount.isPositive']);
    expect(rowFailures({ amount: -1 })).toEqual(['rows.0.amount.isPositive']);
    expect(rowFailures({ amount: 1.234 })).toEqual([
      'rows.0.amount.maxDecimalPlaces',
    ]);
  });

  it('trims the note and rejects an empty or too long one', () => {
    const dto = build({ rows: [row({ note: ' coffee ' })] });
    expect(dto.rows[0].note).toBe('coffee');
    expect(rowFailures({ note: '   ' })).toEqual(['rows.0.note.isLength']);
    expect(rowFailures({ note: 'x'.repeat(256) })).toEqual([
      'rows.0.note.isLength',
    ]);
    expect(rowFailures({ note: 'x'.repeat(255) })).toEqual([]);
  });

  it('trims the market name and rejects an empty one', () => {
    const dto = build({ rows: [row({ market_name: ' Kiosk ' })] });
    expect(dto.rows[0].market_name).toBe('Kiosk');
    expect(rowFailures({ market_name: ' ' })).toEqual([
      'rows.0.market_name.isLength',
    ]);
  });

  it('takes a market id or a market name, not both', () => {
    expect(
      rowFailures({ market_id: randomUUID(), market_name: 'Kiosk' }),
    ).toEqual(['rows.0.market_id.notWithMarketName']);
  });

  it('requires a category and a batch key', () => {
    expect(rowFailures({ category_id: undefined })).toContain(
      'rows.0.category_id.isUuid',
    );
    expect(failuresOf({ client_batch_id: 'nope' })).toEqual([
      'client_batch_id.isUuid',
    ]);
  });

  it('rejects an unknown currency', () => {
    expect(rowFailures({ currency: 'XYZ' })).toEqual([
      'rows.0.currency.isEnum',
    ]);
  });
});
