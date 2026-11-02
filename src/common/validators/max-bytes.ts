import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

export const MAX_BYTES = 'maxBytes';

/** UTF-8 length limit, for values whose consumer counts bytes (e.g. bcrypt). */
export function MaxBytes(
  max: number,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: MAX_BYTES,
      constraints: [max],
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max,
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must be at most $constraint1 bytes long`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
