import { validateSync } from 'class-validator';
import { MaxDecimalPlaces } from './max-decimal-places';

class Probe {
  @MaxDecimalPlaces(2)
  value!: unknown;
}

const errorsFor = (value: unknown) =>
  validateSync(Object.assign(new Probe(), { value }));

describe('MaxDecimalPlaces', () => {
  it('accepts integers and numbers within the decimal limit', () => {
    expect(errorsFor(10)).toHaveLength(0);
    expect(errorsFor(12.3)).toHaveLength(0);
    expect(errorsFor(12.34)).toHaveLength(0);
    expect(errorsFor(0.07)).toHaveLength(0);
    expect(errorsFor(999_999_999_999.99)).toHaveLength(0);
  });

  it('rejects a number with too many decimals', () => {
    const [error] = errorsFor(12.345);
    expect(error.constraints).toEqual({
      maxDecimalPlaces: 'value must have at most 2 decimal places',
    });
  });

  it('rejects exponent-notation fractions instead of throwing', () => {
    expect(() => errorsFor(1e-7)).not.toThrow();
    expect(errorsFor(1e-7)).toHaveLength(1);
  });

  it('rejects non-finite values and non-numbers', () => {
    expect(errorsFor(Infinity)).toHaveLength(1);
    expect(errorsFor(NaN)).toHaveLength(1);
    expect(errorsFor('12.34')).toHaveLength(1);
  });
});
