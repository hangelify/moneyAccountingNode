import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { HttpExceptionWithHeaders } from '../../../common/exceptions/http-exception-with-headers';
import { JwtAuthGuard } from './jwt-auth.guard';

function contextWith(authorization?: string): ExecutionContext {
  const request = { headers: authorization ? { authorization } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function refusal(fn: () => unknown): HttpExceptionWithHeaders {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpExceptionWithHeaders);
    return e as HttpExceptionWithHeaders;
  }
  throw new Error('expected a refusal');
}

describe('JwtAuthGuard.handleRequest', () => {
  const guard = new JwtAuthGuard();
  const user = { id: 'u1' };

  it('returns the authenticated user', () => {
    expect(
      guard.handleRequest(null, user, undefined, contextWith('Bearer t')),
    ).toBe(user);
  });

  it('answers a request without a token with a bare challenge', () => {
    const e = refusal(() =>
      guard.handleRequest(null, false, undefined, contextWith()),
    );
    expect(e.getStatus()).toBe(401);
    expect(e.headers).toEqual({ 'WWW-Authenticate': 'Bearer realm="api"' });
  });

  it('answers a refused token with error="invalid_token"', () => {
    const e = refusal(() =>
      guard.handleRequest(null, false, undefined, contextWith('Bearer t')),
    );
    expect(e.headers).toEqual({
      'WWW-Authenticate': 'Bearer realm="api", error="invalid_token"',
    });
  });

  it('keeps the message of a refusal from validate', () => {
    const e = refusal(() =>
      guard.handleRequest(
        new UnauthorizedException('Session not found or revoked'),
        false,
        undefined,
        contextWith('Bearer t'),
      ),
    );
    expect(e.getResponse()).toMatchObject({
      statusCode: 401,
      message: 'Session not found or revoked',
    });
  });

  it('rethrows an error that is not a refusal', () => {
    const dbDown = new Error('connection refused');
    expect(() =>
      guard.handleRequest(dbDown, false, undefined, contextWith('Bearer t')),
    ).toThrow(dbDown);
  });
});
