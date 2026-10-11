import { HttpStatus, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { HttpExceptionWithHeaders } from '../../../common/exceptions/http-exception-with-headers';
import { normalizeEmail } from '../../../common/transforms/normalize-email';
import { optionalNonNegativeIntEnv } from '../auth.env';
import { LOGIN_ATTEMPT_STORE } from './login-attempt.store';
import type { LockoutPolicy, LoginAttemptStore } from './login-attempt.store';

function positiveIntEnv(name: string, fallback: number): number {
  const value = optionalNonNegativeIntEnv(name, fallback);
  if (value === 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
}

/**
 * Failed logins counted per account, whatever IP they come from: the IP rate
 * limit alone does not stop a guessing run spread over many addresses. After
 * LOGIN_MAX_FAILURES within the window the account is locked; each further
 * failure doubles the lock, up to LOGIN_LOCKOUT_MAX_SECONDS.
 *
 * Every attempt is counted before its password is checked and a successful
 * login clears the count, so parallel requests get no more guesses than
 * sequential ones. If Redis is down, logins fail (closed), as they already do
 * through the IP rate limiter.
 */
@Injectable()
export class LoginLockoutService implements OnModuleInit {
  constructor(
    @Inject(LOGIN_ATTEMPT_STORE) private readonly store: LoginAttemptStore,
  ) {}

  onModuleInit(): void {
    this.policy();
  }

  /** Throws 429 with Retry-After when the account is locked. */
  async reserveAttempt(email: string): Promise<void> {
    const lockedMs = await this.store.reserve(
      failuresKey(email),
      lockKey(email),
      this.policy(),
    );
    if (lockedMs > 0) {
      throw new HttpExceptionWithHeaders(
        'Too many failed login attempts, try again later',
        HttpStatus.TOO_MANY_REQUESTS,
        { 'Retry-After': String(Math.max(Math.ceil(lockedMs / 1000), 1)) },
      );
    }
  }

  async reset(email: string): Promise<void> {
    await this.store.delete(failuresKey(email), lockKey(email));
  }

  private policy(): LockoutPolicy {
    const policy = {
      maxFailures: positiveIntEnv('LOGIN_MAX_FAILURES', 5),
      windowMs: positiveIntEnv('LOGIN_FAILURE_WINDOW_SECONDS', 900) * 1000,
      lockoutMs: positiveIntEnv('LOGIN_LOCKOUT_SECONDS', 60) * 1000,
      lockoutMaxMs: positiveIntEnv('LOGIN_LOCKOUT_MAX_SECONDS', 900) * 1000,
    };
    if (policy.lockoutMs > policy.lockoutMaxMs) {
      throw new Error(
        'LOGIN_LOCKOUT_SECONDS must not exceed LOGIN_LOCKOUT_MAX_SECONDS',
      );
    }
    return policy;
  }
}

const failuresKey = (email: string) => `login:fail:${normalizeEmail(email)}`;
const lockKey = (email: string) => `login:lock:${normalizeEmail(email)}`;
