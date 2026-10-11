import { HttpStatus } from '@nestjs/common';
import { HttpExceptionWithHeaders } from '../../../common/exceptions/http-exception-with-headers';
import { InMemoryLoginAttemptStore } from './login-attempt.store';
import { LoginLockoutService } from './login-lockout.service';

const ENV_KEYS = [
  'LOGIN_MAX_FAILURES',
  'LOGIN_FAILURE_WINDOW_SECONDS',
  'LOGIN_LOCKOUT_SECONDS',
  'LOGIN_LOCKOUT_MAX_SECONDS',
] as const;

describe('LoginLockoutService', () => {
  const saved = ENV_KEYS.map((k) => process.env[k]);
  const email = 'victim@example.com';
  let store: InMemoryLoginAttemptStore;
  let service: LoginLockoutService;

  // Retry-After seconds when the attempt is refused, null when it may go on.
  const attempt = async (address = email): Promise<number | null> => {
    try {
      await service.reserveAttempt(address);
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpExceptionWithHeaders);
      const e = err as HttpExceptionWithHeaders;
      expect(e.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      return Number(e.headers['Retry-After']);
    }
  };

  const attempts = async (times: number, address = email) => {
    for (let i = 0; i < times; i++) expect(await attempt(address)).toBeNull();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    for (const k of ENV_KEYS) delete process.env[k];
    store = new InMemoryLoginAttemptStore();
    service = new LoginLockoutService(store);
  });

  afterEach(() => {
    jest.useRealTimers();
    ENV_KEYS.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  });

  it('lets five attempts through and refuses the sixth', async () => {
    await attempts(5);

    expect(await attempt()).toBe(60);
  });

  it('forgets failures older than the window', async () => {
    await attempts(4);
    jest.advanceTimersByTime(15 * 60_000 + 1);

    await attempts(5);
  });

  it('keeps the window fixed instead of restarting it on every failure', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await attempt()).toBeNull();
      jest.advanceTimersByTime(10 * 60_000);
    }

    expect(await attempt()).toBeNull();
  });

  it('lets only the allowed number of concurrent attempts through', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => attempt()),
    );

    expect(results.filter((r) => r === null)).toHaveLength(5);
    expect(results.filter((r) => r === 60)).toHaveLength(5);
  });

  it('doubles the lock with every further failure, up to the cap', async () => {
    await attempts(5);
    const locks: number[] = [];
    for (let i = 0; i < 6; i++) {
      const seconds = (await attempt()) as number;
      locks.push(seconds);
      jest.advanceTimersByTime(seconds * 1000);
      expect(await attempt()).toBeNull();
    }

    expect(locks).toEqual([60, 120, 240, 480, 900, 900]);
  });

  it('treats the email case- and whitespace-insensitively', async () => {
    await attempts(3, email);
    await attempts(2, ' VICTIM@example.com ');

    expect(await attempt(email)).toBe(60);
  });

  it('keeps accounts apart', async () => {
    await attempts(5);

    expect(await attempt('other@example.com')).toBeNull();
  });

  it('starts from zero after a reset, even when locked', async () => {
    await attempts(5);
    await service.reset(email);

    await attempts(5);
  });

  it('reads the thresholds from env', async () => {
    process.env.LOGIN_MAX_FAILURES = '2';
    process.env.LOGIN_LOCKOUT_SECONDS = '10';
    process.env.LOGIN_LOCKOUT_MAX_SECONDS = '15';

    await attempts(2);
    expect(await attempt()).toBe(10);
    jest.advanceTimersByTime(10_000);
    await attempts(1);
    expect(await attempt()).toBe(15);
  });

  it('rejects a first lock longer than the cap at startup', () => {
    process.env.LOGIN_LOCKOUT_SECONDS = '120';
    process.env.LOGIN_LOCKOUT_MAX_SECONDS = '60';

    expect(() => service.onModuleInit()).toThrow('LOGIN_LOCKOUT_SECONDS');
  });

  it.each(ENV_KEYS)('rejects %s=0 at startup', (key) => {
    process.env[key] = '0';

    expect(() => service.onModuleInit()).toThrow(key);
  });
});
