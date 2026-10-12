import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';
import { isCalendarDate } from '../utils/calendar-date';

export const IS_CALENDAR_DATE = 'isCalendarDate';

/**
 * Plain `YYYY-MM-DD` that exists on the calendar. Unlike `IsDateString`, it
 * rejects times and UTC offsets, which would shift the day once parsed.
 */
export function IsCalendarDate(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: IS_CALENDAR_DATE,
      validator: {
        validate: (value: unknown): boolean => isCalendarDate(value),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must be a valid calendar date in YYYY-MM-DD format`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}
