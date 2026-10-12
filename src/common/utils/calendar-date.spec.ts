import { isCalendarDate, todayIsoDate } from './calendar-date';

describe('isCalendarDate', () => {
  it.each(['2026-05-19', '2024-02-29', '0001-01-01', '9999-12-31'])(
    'accepts %p',
    (v) => expect(isCalendarDate(v)).toBe(true),
  );

  it.each([
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-05-00',
    '2026-5-19',
    '2026-05-19T00:00:00Z',
    '2026-05-19T01:00+03:00',
    ' 2026-05-19',
    '19.05.2026',
    '0000-01-01',
    '',
  ])('rejects %p', (v) => expect(isCalendarDate(v)).toBe(false));

  it.each([null, undefined, 20260519, new Date('2026-05-19')])(
    'rejects non-string %p',
    (v) => expect(isCalendarDate(v)).toBe(false),
  );
});

describe('todayIsoDate', () => {
  it('formats the UTC day of the given instant', () => {
    expect(todayIsoDate(new Date('2026-05-19T23:30:00Z'))).toBe('2026-05-19');
    expect(todayIsoDate(new Date('2026-05-20T00:00:00Z'))).toBe('2026-05-20');
  });
});
