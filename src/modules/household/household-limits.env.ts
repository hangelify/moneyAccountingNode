import { readMaxActiveInvites } from './household-invites.env';

export const HOUSEHOLD_LIMITS = Symbol('HOUSEHOLD_LIMITS');

export interface HouseholdLimits {
  /** Pending, unexpired invites a household may have at once. */
  maxActiveInvites: number;
}

export function readHouseholdLimits(): HouseholdLimits {
  return { maxActiveInvites: readMaxActiveInvites() };
}
