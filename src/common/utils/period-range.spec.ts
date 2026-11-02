import {
  addDays,
  addYears,
  computePeriodRange,
  MAX_CUSTOM_RANGE_YEARS,
} from './period-range';

describe('computePeriodRange', () => {
  const anchor = '2026-10-31';

  it.each([
    ['week', '2026-10-26', '2026-11-02'],
    ['month', '2026-10-01', '2026-11-01'],
    ['quarter', '2026-10-01', '2027-01-01'],
    ['year', '2026-01-01', '2027-01-01'],
    ['5y', '2021-11-01', '2026-11-01'],
  ] as const)('%s around %s', (period, start, end) => {
    expect(computePeriodRange({ period, anchor })).toEqual({
      period,
      start,
      end,
    });
  });

  describe('week (ISO, Monday start)', () => {
    it('keeps a Monday anchor as the start', () => {
      expect(
        computePeriodRange({ period: 'week', anchor: '2026-10-26' }),
      ).toMatchObject({ start: '2026-10-26', end: '2026-11-02' });
    });

    it('puts a Sunday anchor at the end of its week', () => {
      expect(
        computePeriodRange({ period: 'week', anchor: '2026-11-01' }),
      ).toMatchObject({ start: '2026-10-26', end: '2026-11-02' });
    });

    it('crosses the year when the ISO week does', () => {
      // 2027-01-01 is a Friday; its week starts on Monday 2026-12-28.
      expect(
        computePeriodRange({ period: 'week', anchor: '2027-01-01' }),
      ).toMatchObject({ start: '2026-12-28', end: '2027-01-04' });
    });

    it('spans the leap day', () => {
      // 2028-02-29 is a Tuesday.
      expect(
        computePeriodRange({ period: 'week', anchor: '2028-02-29' }),
      ).toMatchObject({ start: '2028-02-28', end: '2028-03-06' });
    });
  });

  it('ends December at the next January', () => {
    expect(
      computePeriodRange({ period: 'month', anchor: '2026-12-15' }),
    ).toMatchObject({ start: '2026-12-01', end: '2027-01-01' });
  });

  it('ends a leap February on March 1', () => {
    expect(
      computePeriodRange({ period: 'month', anchor: '2028-02-29' }),
    ).toMatchObject({ start: '2028-02-01', end: '2028-03-01' });
  });

  it.each([
    ['2026-01-01', '2026-01-01', '2026-04-01'],
    ['2026-06-30', '2026-04-01', '2026-07-01'],
    ['2026-07-01', '2026-07-01', '2026-10-01'],
    ['2026-12-31', '2026-10-01', '2027-01-01'],
  ])('quarter of %s', (a, start, end) => {
    expect(computePeriodRange({ period: 'quarter', anchor: a })).toMatchObject({
      start,
      end,
    });
  });

  it('5y from a January anchor covers 60 months', () => {
    expect(
      computePeriodRange({ period: '5y', anchor: '2026-01-15' }),
    ).toMatchObject({ start: '2021-02-01', end: '2026-02-01' });
  });

  it('5y from a December anchor ends at the next January', () => {
    expect(
      computePeriodRange({ period: '5y', anchor: '2026-12-31' }),
    ).toMatchObject({ start: '2022-01-01', end: '2027-01-01' });
  });

  describe('custom', () => {
    it('makes `to` inclusive', () => {
      expect(
        computePeriodRange({
          period: 'custom',
          from: '2026-03-05',
          to: '2026-03-20',
        }),
      ).toEqual({ period: 'custom', start: '2026-03-05', end: '2026-03-21' });
    });

    it('allows a single day', () => {
      expect(
        computePeriodRange({
          period: 'custom',
          from: '2026-12-31',
          to: '2026-12-31',
        }),
      ).toMatchObject({ start: '2026-12-31', end: '2027-01-01' });
    });

    it('rolls over a leap day', () => {
      expect(
        computePeriodRange({
          period: 'custom',
          from: '2028-02-01',
          to: '2028-02-29',
        }),
      ).toMatchObject({ end: '2028-03-01' });
    });

    it('throws without from/to', () => {
      expect(() => computePeriodRange({ period: 'custom' })).toThrow();
    });
  });

  it('defaults the anchor to the UTC day of `now`', () => {
    expect(
      computePeriodRange(
        { period: 'month' },
        new Date('2026-02-28T23:30:00-05:00'), // 2026-03-01 in UTC
      ),
    ).toMatchObject({ start: '2026-03-01', end: '2026-04-01' });
  });
});

describe('addDays', () => {
  it.each([
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2027-02-28', 1, '2027-03-01'],
    ['2026-01-01', -1, '2025-12-31'],
  ] as const)('%s %+d → %s', (d, n, expected) => {
    expect(addDays(d, n)).toBe(expected);
  });
});

describe('addYears', () => {
  it('keeps month and day', () => {
    expect(addYears('2016-03-05', MAX_CUSTOM_RANGE_YEARS)).toBe('2026-03-05');
  });

  it('clamps Feb 29 to Feb 28 in a common year', () => {
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
  });
});
