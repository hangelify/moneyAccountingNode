import { Type } from '@mikro-orm/core';

/**
 * A `time` column read and written as `HH:MM`. PostgreSQL returns `HH:MM:SS`;
 * a receipt prints no seconds, so they are dropped on read.
 */
export class HourMinuteType extends Type<string | null, string | null> {
  override convertToJSValue(value: string | null): string | null {
    return typeof value === 'string' ? value.slice(0, 5) : value;
  }

  override getColumnType(): string {
    return 'time';
  }

  override compareAsType(): string {
    return 'string';
  }

  override ensureComparable(): boolean {
    return false;
  }
}
