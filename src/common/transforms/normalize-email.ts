import { Transform } from 'class-transformer';

// Emails are stored and compared trimmed and lowercased, so "User@X.com" and
// "user@x.com" are one account (unique index on lower(email)).
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

// Non-strings pass through for @IsEmail to reject.
export const NormalizeEmail = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  );
