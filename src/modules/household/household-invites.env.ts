export const MAX_ACTIVE_INVITES = Symbol('MAX_ACTIVE_INVITES');

const DEFAULT_MAX_ACTIVE_INVITES = 20;

/** Pending, unexpired invites a household may have at once. */
export function readMaxActiveInvites(): number {
  const raw = process.env.HOUSEHOLD_MAX_ACTIVE_INVITES?.trim();
  if (!raw) return DEFAULT_MAX_ACTIVE_INVITES;
  const max = Number(raw);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(
      `HOUSEHOLD_MAX_ACTIVE_INVITES must be a whole number >= 1, got "${raw}"`,
    );
  }
  return max;
}
