import {
  withRetry,
  jitteredBackoff,
  TimeoutError,
  DeadlineExceededError,
} from './retry';

const base = { attempts: 3, backoffMs: 1, timeoutMs: 1000 };

/** A call that never settles on its own and records the abort it receives. */
function hangingCall() {
  const seen: AbortSignal[] = [];
  const fn = jest.fn((signal: AbortSignal) => {
    seen.push(signal);
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () =>
        reject(new Error('aborted by caller')),
      );
    });
  });
  return { fn, seen };
}

describe('withRetry', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns the result on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const r = await withRetry(fn, () => true, base);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient errors up to attempts', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('ok');
    const r = await withRetry(fn, () => true, base);
    expect(r).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws RetryExhaustedError after all attempts fail', async () => {
    const err = new Error('boom');
    const fn = jest.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, () => true, { ...base, attempts: 2 }),
    ).rejects.toMatchObject({ name: 'RetryExhaustedError', cause: err });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry when error is classified as non-transient', async () => {
    const err = new Error('permanent');
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withRetry(fn, () => false, base)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts the in-flight call on timeout and does not retry it', async () => {
    jest.useFakeTimers();
    const { fn, seen } = hangingCall();
    const p = withRetry(fn, () => true, { ...base, timeoutMs: 20 });
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await jest.advanceTimersByTimeAsync(20);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(seen[0].aborted).toBe(true);
    expect(seen[0].reason).toBeInstanceOf(TimeoutError);
  });

  it('rejects on timeout even if the call ignores the signal', async () => {
    jest.useFakeTimers();
    const fn = jest.fn(() => new Promise<string>(() => undefined));
    const p = withRetry(fn, () => true, { ...base, timeoutMs: 20 });
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await jest.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it('propagates the parent deadline into the in-flight call', async () => {
    jest.useFakeTimers();
    const parent = new AbortController();
    const { fn, seen } = hangingCall();
    const p = withRetry(fn, () => true, { ...base, signal: parent.signal });
    const assertion = expect(p).rejects.toBeInstanceOf(DeadlineExceededError);
    parent.abort(new DeadlineExceededError(5));
    await assertion;
    expect(seen[0].aborted).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops waiting for the backoff when the deadline fires', async () => {
    jest.useFakeTimers();
    const parent = new AbortController();
    const fn = jest.fn().mockRejectedValue(new Error('transient'));
    const p = withRetry(fn, () => true, {
      ...base,
      backoffMs: 10_000,
      random: () => 0.99,
      signal: parent.signal,
    });
    const assertion = expect(p).rejects.toBeInstanceOf(DeadlineExceededError);
    await jest.advanceTimersByTimeAsync(0);
    parent.abort(new DeadlineExceededError(5));
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not start when the parent signal is already aborted', async () => {
    const parent = new AbortController();
    parent.abort(new DeadlineExceededError(5));
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(
      withRetry(fn, () => true, { ...base, signal: parent.signal }),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('waits a jittered exponential backoff between attempts', async () => {
    jest.useFakeTimers();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('ok');
    const p = withRetry(fn, () => true, {
      ...base,
      backoffMs: 100,
      random: () => 0.5,
    });
    await jest.advanceTimersByTimeAsync(49); // 0.5 * 100
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(99); // 0.5 * 200
    expect(fn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('ok');
  });

  it('honours retry-after, capped by maxRetryAfterMs', async () => {
    jest.useFakeTimers();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValue('ok');
    const p = withRetry(fn, () => true, {
      ...base,
      retryAfterMs: () => 60_000,
      maxRetryAfterMs: 2_000,
    });
    await jest.advanceTimersByTimeAsync(1_999);
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe('ok');
  });
});

describe('jitteredBackoff', () => {
  it.each([0, 1, 2, 5, 10])('stays within [0, min(max, base*2^%i)]', (i) => {
    const ceiling = Math.min(1_000, 100 * 2 ** i);
    expect(jitteredBackoff(i, 100, 1_000, () => 0)).toBe(0);
    const high = jitteredBackoff(i, 100, 1_000, () => 0.999999);
    expect(high).toBeLessThan(ceiling);
    expect(high).toBeGreaterThan(ceiling * 0.99);
    for (let k = 0; k < 50; k++) {
      const d = jitteredBackoff(i, 100, 1_000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(ceiling);
    }
  });
});
