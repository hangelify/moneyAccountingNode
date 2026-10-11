export const DRAFT_RETENTION_DAYS = Symbol('DRAFT_RETENTION_DAYS');

const DEFAULT_DRAFT_RETENTION_DAYS = 30;

/** Days an unconfirmed draft is kept before the daily cleanup deletes it. */
export function readDraftRetentionDays(): number {
  const raw = process.env.DRAFT_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_DRAFT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      `DRAFT_RETENTION_DAYS must be a whole number of days >= 1, got "${raw}"`,
    );
  }
  return days;
}
