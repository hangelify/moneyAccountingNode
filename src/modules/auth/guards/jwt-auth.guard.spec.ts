import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HttpExceptionWithHeaders } from '../../../common/exceptions/http-exception-with-headers';
import { AllowUnverified } from '../decorators/allow-unverified.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

class Gated {
  handle() {}
}

function contextWith(authorization?: string, cls = Gated): ExecutionContext {
  const request = { headers: authorization ? { authorization } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => Reflect.get(cls.prototype, 'handle') as object,
    getClass: () => cls,
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
  const guard = new JwtAuthGuard(new Reflector());
  const user = { id: 'u1', email_verified_at: new Date() };
  const unverified = { id: 'u2', email_verified_at: null };

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

  it('refuses an unverified user with 403 email_not_verified', () => {
    let error: unknown;
    try {
      guard.handleRequest(null, unverified, undefined, contextWith('Bearer t'));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ForbiddenException);
    const forbidden = error as ForbiddenException;
    expect(forbidden.getStatus()).toBe(403);
    expect(forbidden.getResponse()).toEqual({
      statusCode: 403,
      error: 'email_not_verified',
      message: 'Email address is not verified',
    });
  });

  it('lets an unverified user through a handler marked @AllowUnverified()', () => {
    class Open {
      @AllowUnverified()
      handle() {}
    }
    expect(
      guard.handleRequest(
        null,
        unverified,
        undefined,
        contextWith('Bearer t', Open),
      ),
    ).toBe(unverified);
  });

  it('lets an unverified user through a class marked @AllowUnverified()', () => {
    @AllowUnverified()
    class Open {
      handle() {}
    }
    expect(
      guard.handleRequest(
        null,
        unverified,
        undefined,
        contextWith('Bearer t', Open),
      ),
    ).toBe(unverified);
  });
});
