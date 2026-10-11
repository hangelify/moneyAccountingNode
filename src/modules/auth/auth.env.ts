export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

export function requireIntEnv(name: string): number {
  const raw = requireEnv(name);
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Environment variable ${name} must be a positive integer, got: ${raw}`,
    );
  }
  return parsed;
}

export function optionalNonNegativeIntEnv(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Environment variable ${name} must be a non-negative integer, got: ${raw}`,
    );
  }
  return parseInt(raw, 10);
}

const MIN_JWT_SECRET_BYTES = 32;

// HS256 keys shorter than the hash output weaken the signature (RFC 7518
// §3.2); one secret for both token kinds would let a refresh token pass as an
// access token if the type checks ever regressed.
export function assertJwtSecrets(): void {
  const access = requireEnv('JWT_SECRET');
  const refresh = requireEnv('JWT_REFRESH_SECRET');
  for (const [name, value] of [
    ['JWT_SECRET', access],
    ['JWT_REFRESH_SECRET', refresh],
  ]) {
    if (Buffer.byteLength(value, 'utf8') < MIN_JWT_SECRET_BYTES) {
      throw new Error(
        `Environment variable ${name} must be at least ${MIN_JWT_SECRET_BYTES} bytes long`,
      );
    }
  }
  if (access === refresh) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must differ');
  }
}
