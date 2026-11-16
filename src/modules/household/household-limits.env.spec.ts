import { readMaxHouseholds } from './household-limits.env';

describe('readMaxHouseholds', () => {
  const original = process.env['HOUSEHOLD_MAX_HOUSEHOLDS'];
  afterEach(() => {
    if (original === undefined) delete process.env['HOUSEHOLD_MAX_HOUSEHOLDS'];
    else process.env['HOUSEHOLD_MAX_HOUSEHOLDS'] = original;
  });

  it('defaults to 5 households', () => {
    delete process.env['HOUSEHOLD_MAX_HOUSEHOLDS'];
    expect(readMaxHouseholds()).toBe(5);
  });

  it('reads a positive whole number', () => {
    process.env['HOUSEHOLD_MAX_HOUSEHOLDS'] = '3';
    expect(readMaxHouseholds()).toBe(3);
  });

  it.each(['0', '-1', '2.5', 'x'])(
    'refuses to start with HOUSEHOLD_MAX_HOUSEHOLDS=%s',
    (value) => {
      process.env['HOUSEHOLD_MAX_HOUSEHOLDS'] = value;
      expect(() => readMaxHouseholds()).toThrow(/HOUSEHOLD_MAX_HOUSEHOLDS/);
    },
  );
});
