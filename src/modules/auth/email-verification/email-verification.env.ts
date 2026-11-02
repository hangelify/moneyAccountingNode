export const EMAIL_VERIFICATION_CONFIG = Symbol('EMAIL_VERIFICATION_CONFIG');

export interface EmailVerificationConfig {
  /** Base of the link in the email; the frontend calls POST /auth/verify-email. */
  frontendUrl: string;
  ttlHours: number;
}

const DEFAULT_TTL_HOURS = 24;

export function readEmailVerificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): EmailVerificationConfig {
  const frontendUrl = env.FRONTEND_URL?.trim();
  if (!frontendUrl) {
    throw new Error('Required environment variable FRONTEND_URL is not set');
  }

  const raw = env.EMAIL_VERIFICATION_TTL_HOURS?.trim();
  const ttlHours = raw ? Number(raw) : DEFAULT_TTL_HOURS;
  if (!Number.isInteger(ttlHours) || ttlHours < 1) {
    throw new Error(
      `EMAIL_VERIFICATION_TTL_HOURS must be a whole number of hours >= 1, got "${raw}"`,
    );
  }
  return { frontendUrl, ttlHours };
}
