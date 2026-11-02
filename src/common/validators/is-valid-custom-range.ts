import { ValidateBy, ValidationOptions } from 'class-validator';
import { isCalendarDate } from '../utils/calendar-date';
import { addYears, MAX_CUSTOM_RANGE_YEARS } from '../utils/period-range';

export const IS_VALID_CUSTOM_RANGE = 'isValidCustomRange';

/**
 * On the inclusive end day of a range: not before the start day named by
 * `fromProperty`, and at most MAX_CUSTOM_RANGE_YEARS after it. Malformed days
 * are left to IsCalendarDate.
 */
export function IsValidCustomRange(
  fromProperty: string,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: IS_VALID_CUSTOM_RANGE,
      constraints: [fromProperty],
      validator: {
        validate: (to: unknown, args): boolean => {
          const from = (args?.object as Record<string, unknown>)[fromProperty];
          if (!isCalendarDate(from) || !isCalendarDate(to)) return true;
          // YYYY-MM-DD strings compare in calendar order.
          return from <= to && to < addYears(from, MAX_CUSTOM_RANGE_YEARS);
        },
        defaultMessage: (args): string => {
          const from = (args?.object as Record<string, unknown>)[fromProperty];
          return (from as string) > (args?.value as string)
            ? `${args?.property} must not be before ${fromProperty}`
            : `${args?.property} must be at most ${MAX_CUSTOM_RANGE_YEARS} years after ${fromProperty}`;
        },
      },
    },
    validationOptions,
  );
}
