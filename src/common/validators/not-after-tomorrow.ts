import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';
import { addCalendarDays, chisinauToday } from '../utils/calendar-date';

export const NOT_AFTER_TOMORROW = 'notAfterTomorrow';

/**
 * A `YYYY-MM-DD` day no later than tomorrow in Chisinau: today plus one day
 * of margin for a user in another time zone. Leaves other values to
 * `IsCalendarDate`.
 */
export function NotAfterTomorrow(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: NOT_AFTER_TOMORROW,
      validator: {
        validate: (value: unknown): boolean =>
          typeof value !== 'string' ||
          value <= addCalendarDays(chisinauToday(), 1),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must not be later than tomorrow`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
