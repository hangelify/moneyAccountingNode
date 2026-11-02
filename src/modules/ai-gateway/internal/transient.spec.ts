import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { isTransient, retryAfterMs } from './transient';
import { TimeoutError } from './retry';

describe('isTransient', () => {
  it.each([408, 409, 429, 500, 502, 503, 529])(
    'treats %i as transient',
    (s) => {
      expect(isTransient({ status: s })).toBe(true);
    },
  );

  it.each([400, 401, 403, 404, 422])('treats %i as permanent', (s) => {
    expect(isTransient({ status: s })).toBe(false);
  });

  it('treats SDK connection errors as transient', () => {
    expect(isTransient(new Anthropic.APIConnectionError({}))).toBe(true);
    expect(isTransient(new OpenAI.APIConnectionError({}))).toBe(true);
  });

  it('does not retry timeouts or aborts', () => {
    expect(isTransient(new TimeoutError(10))).toBe(false);
    expect(isTransient(new Anthropic.APIConnectionTimeoutError())).toBe(false);
    expect(isTransient(new OpenAI.APIConnectionTimeoutError())).toBe(false);
    expect(isTransient(new OpenAI.APIUserAbortError())).toBe(false);
  });

  it('classifies real SDK status errors', () => {
    const err = OpenAI.APIError.generate(429, {}, 'rate', new Headers());
    expect(isTransient(err)).toBe(true);
    const bad = Anthropic.APIError.generate(400, {}, 'bad', new Headers());
    expect(isTransient(bad)).toBe(false);
  });

  it('ignores unrelated errors', () => {
    expect(isTransient(new Error('boom'))).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});

describe('retryAfterMs', () => {
  const at429 = (h: Record<string, string>) =>
    OpenAI.APIError.generate(429, {}, 'rate', new Headers(h));

  it('reads retry-after seconds', () => {
    expect(retryAfterMs(at429({ 'retry-after': '3' }))).toBe(3000);
  });

  it('prefers retry-after-ms', () => {
    expect(
      retryAfterMs(at429({ 'retry-after-ms': '1500', 'retry-after': '3' })),
    ).toBe(1500);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const date = new Date(now + 4000).toUTCString();
    expect(retryAfterMs(at429({ 'retry-after': date }))).toBe(4000);
    jest.restoreAllMocks();
  });

  it('returns undefined without a usable header or for non-429', () => {
    expect(retryAfterMs(at429({}))).toBeUndefined();
    expect(retryAfterMs(at429({ 'retry-after': 'soon' }))).toBeUndefined();
    const s503 = OpenAI.APIError.generate(
      503,
      {},
      'x',
      new Headers({ 'retry-after': '3' }),
    );
    expect(retryAfterMs(s503)).toBeUndefined();
    expect(retryAfterMs(new Error('x'))).toBeUndefined();
  });
});
