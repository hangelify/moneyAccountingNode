import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ListBillsQueryDto } from './list-bills-query.dto';
import { Currency } from '../../../types/currency.enum';

function toDto(plain: Record<string, unknown>): ListBillsQueryDto {
  return plainToInstance(ListBillsQueryDto, plain);
}

describe('ListBillsQueryDto', () => {
  it('passes when all fields are absent', async () => {
    const errors = await validate(toDto({}));
    expect(errors).toHaveLength(0);
  });

  it('passes with valid date_from and date_to', async () => {
    const errors = await validate(
      toDto({ date_from: '2026-01-01', date_to: '2026-12-31' }),
    );
    expect(errors).toHaveLength(0);
  });

  it('fails when date_from is not a valid date string', async () => {
    const errors = await validate(toDto({ date_from: '2026-13-01' }));
    expect(errors.some((e) => e.property === 'date_from')).toBe(true);
  });

  it('coerces date_from="" to absent (no validation error)', async () => {
    const dto = toDto({ date_from: '' });
    expect(dto.date_from).toBeUndefined();
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'date_from')).toBe(false);
  });

  it('fails when amount_range element does not match gt_N or lt_N', async () => {
    const errors = await validate(toDto({ amount_range: ['between_50_100'] }));
    expect(errors.some((e) => e.property === 'amount_range')).toBe(true);
  });

  it('passes with a single valid amount_range value', async () => {
    const errors = await validate(toDto({ amount_range: ['gt_100'] }));
    expect(errors).toHaveLength(0);
  });

  it('passes with two amount_range values forming a range', async () => {
    const errors = await validate(
      toDto({ amount_range: ['gt_100', 'lt_500'] }),
    );
    expect(errors).toHaveLength(0);
  });

  it('normalises a single amount_range string to an array', async () => {
    const dto = toDto({ amount_range: 'gt_100' });
    expect(dto.amount_range).toEqual(['gt_100']);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails when a market_names element is an empty string', async () => {
    const dto = toDto({ market_names: ['Lidl', ''] });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'market_names')).toBe(true);
  });

  it('normalises a single market_name string to an array', async () => {
    const dto = toDto({ market_names: 'Lidl' });
    expect(dto.market_names).toEqual(['Lidl']);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('passes with a valid currency', async () => {
    const errors = await validate(toDto({ currency: Currency.EUR }));
    expect(errors).toHaveLength(0);
  });

  it('fails when currency is an unknown value', async () => {
    const errors = await validate(toDto({ currency: 'XYZ' }));
    expect(errors.some((e) => e.property === 'currency')).toBe(true);
  });

  it("include_duplicates parses 'true' and rejects 'yes'", async () => {
    const ok = toDto({ include_duplicates: 'true' });
    expect(ok.include_duplicates).toBe(true);
    expect(await validate(ok)).toHaveLength(0);
    const no = toDto({ include_duplicates: 'false' });
    expect(no.include_duplicates).toBe(false);
    const bad = await validate(toDto({ include_duplicates: 'yes' }));
    expect(bad.some((e) => e.property === 'include_duplicates')).toBe(true);
  });
});
