import { validateSync } from 'class-validator';
import { NotAfterTomorrow } from './not-after-tomorrow';

class Probe {
  @NotAfterTomorrow()
  value!: unknown;
}

const errorsFor = (value: unknown) =>
  validateSync(Object.assign(new Probe(), { value }));

describe('NotAfterTomorrow', () => {
  afterEach(() => jest.useRealTimers());

  it('accepts today, tomorrow and any past day in Chisinau', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-09T12:00:00Z'));
    expect(errorsFor('2026-11-09')).toHaveLength(0);
    expect(errorsFor('2026-11-10')).toHaveLength(0);
    expect(errorsFor('2020-01-01')).toHaveLength(0);
  });

  it('rejects the day after tomorrow', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-09T12:00:00Z'));
    const [error] = errorsFor('2026-11-11');
    expect(error.constraints).toEqual({
      notAfterTomorrow: 'value must not be later than tomorrow',
    });
  });

  it('counts the day in Chisinau, not in UTC', () => {
    // 01:30 on 2026-11-10 in Chisinau.
    jest.useFakeTimers().setSystemTime(new Date('2026-11-09T23:30:00Z'));
    expect(errorsFor('2026-11-11')).toHaveLength(0);
  });

  it('crosses month and year ends', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T12:00:00Z'));
    expect(errorsFor('2027-01-01')).toHaveLength(0);
    expect(errorsFor('2027-01-02')).toHaveLength(1);
  });

  it('leaves non-strings to the date format check', () => {
    expect(errorsFor(42)).toHaveLength(0);
  });
});
