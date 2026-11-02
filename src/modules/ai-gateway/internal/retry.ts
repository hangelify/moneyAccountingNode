export interface RetryOptions {
  attempts: number; // total tries (including the first)
  backoffMs: number; // base delay; full jitter over base * 2^retry
  maxBackoffMs?: number; // cap of a single backoff delay
  timeoutMs: number; // hard per-attempt timeout; aborts the call
  signal?: AbortSignal; // parent deadline; aborts the call and the backoff
  retryAfterMs?: (err: unknown) => number | undefined; // server-requested delay
  maxRetryAfterMs?: number; // cap of a server-requested delay
  random?: () => number; // injectable for tests
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export class DeadlineExceededError extends Error {
  constructor(ms: number) {
    super(`AI task deadline of ${ms}ms exceeded`);
    this.name = 'DeadlineExceededError';
  }
}

export class RetryExhaustedError extends Error {
  constructor(public override readonly cause: unknown) {
    super('All retry attempts exhausted');
    this.name = 'RetryExhaustedError';
  }
}

function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new Error(String(r));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Settles with the signal's reason as soon as it aborts, even if `promise` ignores it. */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        // Pass through as-is: classification relies on fields like `status`.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(e);
      },
    );
  });
}

/** Full jitter: uniform in [0, min(max, base * 2^retry)). */
export function jitteredBackoff(
  retry: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  return random() * Math.min(maxMs, baseMs * Math.pow(2, retry));
}

async function attempt<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(parent!.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(
    () => ctrl.abort(new TimeoutError(timeoutMs)),
    timeoutMs,
  );
  try {
    return await raceAbort(
      new Promise<T>((resolve) => resolve(fn(ctrl.signal))),
      ctrl.signal,
    );
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  isTransient: (err: unknown) => boolean,
  opts: RetryOptions,
): Promise<T> {
  const { signal } = opts;
  let lastErr: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await attempt(fn, opts.timeoutMs, signal);
    } catch (err) {
      lastErr = err;
      // A deadline or a timeout is final for this provider: a timed-out
      // generation is most likely billed, so it must not be repeated here.
      if (signal?.aborted) throw abortReason(signal);
      if (err instanceof TimeoutError || !isTransient(err)) throw err;
      if (i < opts.attempts - 1) {
        const requested = opts.retryAfterMs?.(err);
        const delay =
          requested !== undefined
            ? Math.min(requested, opts.maxRetryAfterMs ?? Infinity)
            : jitteredBackoff(
                i,
                opts.backoffMs,
                opts.maxBackoffMs ?? Infinity,
                opts.random,
              );
        await sleep(delay, signal);
      }
    }
  }
  if (opts.attempts <= 1) {
    throw lastErr;
  }
  throw new RetryExhaustedError(lastErr);
}
