import { validateSync } from 'class-validator';
import { MaxBytes } from './max-bytes';

class Probe {
  @MaxBytes(4)
  value!: unknown;
}

const errorsFor = (value: unknown) =>
  validateSync(Object.assign(new Probe(), { value }));

describe('MaxBytes', () => {
  it('accepts a string within the byte limit', () => {
    expect(errorsFor('abcd')).toHaveLength(0);
    expect(errorsFor('éé')).toHaveLength(0);
  });

  it('counts UTF-8 bytes, not characters', () => {
    const [error] = errorsFor('ééa');
    expect(error.constraints).toEqual({
      maxBytes: 'value must be at most 4 bytes long',
    });
  });

  it('rejects a non-string value', () => {
    expect(errorsFor(12)).toHaveLength(1);
  });
});
