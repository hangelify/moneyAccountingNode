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
