import { AiCallConfig, loadAiCallConfig } from '../../internal/ai-call-config';
import { DeadlineExceededError, TimeoutError } from '../../internal/retry';
import { LlmProvider } from '../../types/llm-provider';
import { LlmRequest } from '../../types/llm-request';

export function testAiCallConfig(
  overrides: Partial<AiCallConfig> = {},
): AiCallConfig {
  return { ...loadAiCallConfig({}), ...overrides };
}

const req: LlmRequest = {
  messages: [{ role: 'user', text: 'hi' }],
  jsonSchema: { type: 'object' },
};

/** Never settles on its own; rejects like the SDK does once aborted. */
function hangingSdkCall(_body: unknown, opts: { signal: AbortSignal }) {
  return new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () =>
      reject(new Error('Request was aborted.')),
    );
  });
}

function sdkCallOptions(create: jest.Mock): { signal: AbortSignal } {
  return (create.mock.calls as unknown[][])[0][1] as { signal: AbortSignal };
}

/**
 * Shared contract for every SDK-backed provider: one HTTP call per attempt,
 * bounded by our own timeout and the caller's deadline signal.
 */
export function itBoundsSdkCalls(opts: {
  env: Record<string, string>;
  make: (cfg: AiCallConfig) => LlmProvider;
  ctor: jest.Mock;
  create: jest.Mock;
  okResponse: unknown;
  connectionError: () => Error;
}) {
  describe('call bounds', () => {
    beforeEach(() => {
      Object.assign(process.env, opts.env);
      opts.create.mockReset();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('creates the SDK client with SDK-level retries disabled', () => {
      opts.ctor.mockClear();
      opts.make(testAiCallConfig());
      expect(opts.ctor).toHaveBeenCalledWith(
        expect.objectContaining({ maxRetries: 0 }),
      );
    });

    it('passes an abort signal and the call timeout to the SDK', async () => {
      opts.create.mockResolvedValue(opts.okResponse);
      await opts.make(testAiCallConfig({ callTimeoutMs: 1234 })).complete(req);
      expect(sdkCallOptions(opts.create)).toEqual({
        signal: expect.any(AbortSignal) as AbortSignal,
        timeout: 1234,
      });
    });

    it('aborts the SDK request on timeout and does not retry it', async () => {
      jest.useFakeTimers();
      opts.create.mockImplementation(hangingSdkCall);
      const p = opts
        .make(testAiCallConfig({ callTimeoutMs: 50, retryAttempts: 2 }))
        .complete(req);
      const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
      await jest.advanceTimersByTimeAsync(50);
      await assertion;
      expect(opts.create).toHaveBeenCalledTimes(1);
      const { signal } = sdkCallOptions(opts.create);
      expect(signal.aborted).toBe(true);
    });

    it('aborts the SDK request when the caller deadline fires', async () => {
      opts.create.mockImplementation(hangingSdkCall);
      const deadline = new AbortController();
      const p = opts
        .make(testAiCallConfig())
        .complete(req, { signal: deadline.signal });
      deadline.abort(new DeadlineExceededError(1));
      await expect(p).rejects.toBeInstanceOf(DeadlineExceededError);
      const { signal } = sdkCallOptions(opts.create);
      expect(signal.aborted).toBe(true);
    });

    it('retries an SDK connection error on the same provider', async () => {
      opts.create
        .mockRejectedValueOnce(opts.connectionError())
        .mockResolvedValue(opts.okResponse);
      await opts
        .make(testAiCallConfig({ retryAttempts: 1, retryBackoffMs: 0 }))
        .complete(req);
      expect(opts.create).toHaveBeenCalledTimes(2);
    });
  });
}
