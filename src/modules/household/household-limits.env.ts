import { readMaxActiveInvites } from './household-invites.env';

export const HOUSEHOLD_LIMITS = Symbol('HOUSEHOLD_LIMITS');

export interface HouseholdLimits {
  /** Pending, unexpired invites a household may have at once. */
  maxActiveInvites: number;
  /** Live households a user may belong to, owned or joined. */
  maxHouseholds: number;
}

const DEFAULT_MAX_HOUSEHOLDS = 5;

export function readMaxHouseholds(): number {
  const raw = process.env['HOUSEHOLD_MAX_HOUSEHOLDS']?.trim();
  if (!raw) return DEFAULT_MAX_HOUSEHOLDS;
  const max = Number(raw);
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(
      `HOUSEHOLD_MAX_HOUSEHOLDS must be a whole number >= 1, got "${raw}"`,
    );
  }
  return max;
}

export function readHouseholdLimits(): HouseholdLimits {
  return {
    maxActiveInvites: readMaxActiveInvites(),
    maxHouseholds: readMaxHouseholds(),
  };
}
