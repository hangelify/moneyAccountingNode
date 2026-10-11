import type { Request, Response } from 'express';
import {
  clearRefreshCookie,
  readRefreshCookie,
  REFRESH_COOKIE,
  setRefreshCookie,
} from './refresh-cookie';

describe('refresh cookie', () => {
  const original = process.env.JWT_REFRESH_EXPIRES_IN_MS;
  beforeAll(() => {
    process.env.JWT_REFRESH_EXPIRES_IN_MS = '604800000';
  });
  afterAll(() => {
    process.env.JWT_REFRESH_EXPIRES_IN_MS = original;
  });

  const attributes = {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth',
  };

  it('sets an HttpOnly, Secure, SameSite=Strict cookie scoped to /auth', () => {
    const cookie = jest.fn();
    setRefreshCookie({ cookie } as unknown as Response, 'token');
    expect(cookie).toHaveBeenCalledWith(REFRESH_COOKIE, 'token', {
      ...attributes,
      maxAge: 604800000,
    });
  });

  it('clears the cookie with the same attributes', () => {
    const clearCookie = jest.fn();
    clearRefreshCookie({ clearCookie } as unknown as Response);
    expect(clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE, attributes);
  });

  it('reads only non-empty string cookies', () => {
    const read = (cookies: unknown) =>
      readRefreshCookie({ cookies } as Request);
    expect(read({ refresh_token: 'abc' })).toBe('abc');
    expect(read({ refresh_token: '' })).toBeUndefined();
    expect(read(undefined)).toBeUndefined();
  });
});
