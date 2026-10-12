import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

export const MAX_DECIMAL_PLACES = 'maxDecimalPlaces';

/**
 * Decimal-places limit for numbers. Unlike `IsNumber({ maxDecimalPlaces })`,
 * it does not throw on exponent notation such as `1e-7`.
 */
export function MaxDecimalPlaces(
  places: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const factor = 10 ** places;
  return ValidateBy(
    {
      name: MAX_DECIMAL_PLACES,
      constraints: [places],
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'number' &&
          Number.isFinite(value) &&
          Math.round(value * factor) / factor === value,
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must have at most $constraint1 decimal places`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
