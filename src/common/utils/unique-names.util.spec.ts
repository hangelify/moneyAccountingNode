import { BadRequestException } from '@nestjs/common';
import { assertUniqueNames } from './unique-names.util';

describe('assertUniqueNames', () => {
  it('accepts distinct names', () => {
    expect(() => assertUniqueNames(['Food', 'Fuel'])).not.toThrow();
  });

  it('rejects names that differ only in case with 400 naming them', () => {
    expect(() => assertUniqueNames(['Food', 'Fuel', 'FOOD'])).toThrow(
      new BadRequestException('Duplicate names in request: FOOD'),
    );
  });
});
