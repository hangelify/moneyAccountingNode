export const RETENTION_CONFIG = Symbol('RETENTION_CONFIG');

/** Days after which the daily retention job clears each kind of data. */
export interface RetentionConfig {
  /** Refresh tokens are deleted this long after they expire. */
  refreshTokenDays: number;
  /** Sessions are deleted this long after they expire or go idle. */
  sessionDays: number;
  /** AI prompts and answers are nulled this long after the request. */
  aiAuditRawDays: number;
}

function readDays(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      `${name} must be a whole number of days >= 1, got "${raw}"`,
    );
  }
  return days;
}

export function readRetentionConfig(): RetentionConfig {
  return {
    refreshTokenDays: readDays('REFRESH_TOKEN_RETENTION_DAYS', 7),
    sessionDays: readDays('SESSION_RETENTION_DAYS', 30),
    aiAuditRawDays: readDays('AI_AUDIT_RAW_RETENTION_DAYS', 30),
  };
}
