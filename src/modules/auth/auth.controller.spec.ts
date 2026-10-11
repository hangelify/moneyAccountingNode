import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';

describe('AuthController – @Throttle metadata', () => {
  const THROTTLER_NAME = 'default';
  // 'THROTTLER:LIMIT' / 'THROTTLER:TTL' are not re-exported from @nestjs/throttler's public API
  const THROTTLER_LIMIT_KEY = 'THROTTLER:LIMIT';
  const THROTTLER_TTL_KEY = 'THROTTLER:TTL';
  const EXPECTED_LIMIT = 10;
  const EXPECTED_TTL = 60_000;

  it.each([
    ['login', 'login' as const],
    ['register', 'register' as const],
    ['refresh', 'refresh' as const],
    ['revoke', 'revoke' as const],
  ])('%s has throttle limit of 10 req/60s', (_name, methodName) => {
    const method = AuthController.prototype[methodName];
    const limit: unknown = Reflect.getMetadata(
      THROTTLER_LIMIT_KEY + THROTTLER_NAME,
      method,
    );
    expect(limit).toBe(EXPECTED_LIMIT);
  });

  it.each([
    ['login', 'login' as const],
    ['register', 'register' as const],
    ['refresh', 'refresh' as const],
    ['revoke', 'revoke' as const],
  ])('%s has throttle ttl of 60s', (_name, methodName) => {
    const method = AuthController.prototype[methodName];
    const ttl: unknown = Reflect.getMetadata(
      THROTTLER_TTL_KEY + THROTTLER_NAME,
      method,
    );
    expect(ttl).toBe(EXPECTED_TTL);
  });
});

describe('AuthController – login guards', () => {
  // A guard on login would run before ValidationPipe and see the raw body.
  it('login has no guards, so the body is validated before credentials are checked', () => {
    const methodName = 'login' as const;
    const method = AuthController.prototype[methodName];
    const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, method);
    expect(guards).toBeUndefined();
  });
});
