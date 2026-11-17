import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SetCarryOverDto } from './carry-over.dto';

const VALID = {
  period_type: 'MONTHLY',
  period_start: '2026-09-01',
  carry_over: false,
};

const errorsOf = async (plain: Record<string, unknown>): Promise<string[]> =>
  (await validate(plainToInstance(SetCarryOverDto, plain))).map(
    (e) => e.property,
  );

describe('SetCarryOverDto', () => {
  it.each([false, true])('passes with carry_over %s', async (carry_over) => {
    expect(await errorsOf({ ...VALID, carry_over })).toEqual([]);
  });

  it.each([
    ['period_type', undefined],
    ['period_type', 'WEEKLY'],
    ['period_start', undefined],
    ['period_start', '2026-02-30'],
    ['period_start', '2026-09-01T00:00:00Z'],
    ['carry_over', undefined],
    ['carry_over', 'false'],
    ['carry_over', 0],
  ])('fails when %s is %p', async (field, value) => {
    expect(await errorsOf({ ...VALID, [field]: value })).toEqual([field]);
  });
});
