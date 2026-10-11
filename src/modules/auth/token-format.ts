// What every issued token looks like and what verification insists on
// (RFC 8725 §3.1, 3.8, 3.11; RFC 9068 §2.1).

export const JWT_ALGORITHM = 'HS256';

// Explicit typing keeps one kind of token from being accepted as the other.
// at+jwt is registered by RFC 9068; rt+jwt is a private value.
export const ACCESS_TOKEN_TYP = 'at+jwt';
export const REFRESH_TOKEN_TYP = 'rt+jwt';

// typ is a media type: case-insensitive, "application/" prefix optional
// (RFC 7515 §4.1.9).
export function hasTyp(typ: unknown, expected: string): boolean {
  if (typeof typ !== 'string') return false;
  const value = typ.toLowerCase();
  return value === expected || value === `application/${expected}`;
}

const DEFAULT_ISSUER = 'accounting-api';
const DEFAULT_AUDIENCE = 'accounting-api';

export function jwtIssuer(): string {
  return process.env.JWT_ISSUER || DEFAULT_ISSUER;
}

export function jwtAudience(): string {
  return process.env.JWT_AUDIENCE || DEFAULT_AUDIENCE;
}
