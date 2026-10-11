import type { CookieOptions, Request, Response } from 'express';
import { requireIntEnv } from './auth.env';

export const REFRESH_COOKIE = 'refresh_token';

// Chrome and Firefox accept Secure cookies on http://localhost, and
// localhost:5173 and localhost:3000 are the same site, so these attributes
// also work in local development.
const ATTRIBUTES: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/auth',
};

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...ATTRIBUTES,
    maxAge: requireIntEnv('JWT_REFRESH_EXPIRES_IN_MS'),
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, ATTRIBUTES);
}

export function readRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
