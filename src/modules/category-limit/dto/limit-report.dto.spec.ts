import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { LimitReportQueryDto } from './limit-report.dto';

const errorsOf = async (plain: Record<string, unknown>): Promise<string[]> =>
  (await validate(plainToInstance(LimitReportQueryDto, plain))).map(
    (e) => e.property,
  );

describe('LimitReportQueryDto', () => {
  it('passes with a period type alone', async () => {
    expect(await errorsOf({ period_type: 'MONTHLY' })).toEqual([]);
  });

  it('passes with a period type and a calendar day', async () => {
    expect(
      await errorsOf({ period_type: 'SEMI_ANNUAL', date: '2027-02-28' }),
    ).toEqual([]);
  });

  it('fails without period_type', async () => {
    expect(await errorsOf({ date: '2026-11-15' })).toEqual(['period_type']);
  });

  it('fails for an unknown period_type', async () => {
    expect(await errorsOf({ period_type: 'WEEKLY' })).toEqual(['period_type']);
  });

  it.each(['2026-02-30', '2026-11-15T00:00:00Z', '15.11.2026'])(
    'fails for date %s',
    async (date) => {
      expect(await errorsOf({ period_type: 'MONTHLY', date })).toEqual([
        'date',
      ]);
    },
  );
});
