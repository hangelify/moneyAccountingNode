import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  classifyError,
  failureKind,
  InvalidResponseError,
  RefusalError,
  TruncatedResponseError,
} from './error-classifier';
import { AiAttemptErrorCode } from '../../../entities/ai-request-attempt.entity';
import {
  DeadlineExceededError,
  RetryExhaustedError,
  TimeoutError,
} from './retry';

describe('classifyError', () => {
  it('classifies TimeoutError as TIMEOUT', () => {
    expect(classifyError(new TimeoutError(100)).code).toBe(
      AiAttemptErrorCode.TIMEOUT,
    );
  });

  it('classifies DeadlineExceededError as TIMEOUT', () => {
    expect(classifyError(new DeadlineExceededError(100)).code).toBe(
      AiAttemptErrorCode.TIMEOUT,
    );
  });

  it('classifies SDK connection timeouts as TIMEOUT', () => {
    expect(classifyError(new Anthropic.APIConnectionTimeoutError()).code).toBe(
      AiAttemptErrorCode.TIMEOUT,
    );
    expect(classifyError(new OpenAI.APIConnectionTimeoutError()).code).toBe(
      AiAttemptErrorCode.TIMEOUT,
    );
  });

  it('classifies RetryExhaustedError by its underlying cause', () => {
    const exhausted = new RetryExhaustedError({ status: 429 });
    expect(classifyError(exhausted).code).toBe(AiAttemptErrorCode.RATE_LIMIT);
  });

  it('classifies 429 status as RATE_LIMIT', () => {
    expect(classifyError({ status: 429 }).code).toBe(
      AiAttemptErrorCode.RATE_LIMIT,
    );
  });

  it('classifies 5xx status as SERVER_ERROR', () => {
    expect(classifyError({ status: 502 }).code).toBe(
      AiAttemptErrorCode.SERVER_ERROR,
    );
  });

  it('classifies other 4xx as PROVIDER_ERROR', () => {
    expect(classifyError({ status: 401 }).code).toBe(
      AiAttemptErrorCode.PROVIDER_ERROR,
    );
  });

  it('classifies InvalidResponseError as INVALID_RESPONSE', () => {
    expect(classifyError(new InvalidResponseError('bad json', '{')).code).toBe(
      AiAttemptErrorCode.INVALID_RESPONSE,
    );
  });

  it('classifies TruncatedResponseError as TRUNCATED', () => {
    expect(
      classifyError(new TruncatedResponseError('cut off', '{"a":')).code,
    ).toBe(AiAttemptErrorCode.TRUNCATED);
  });

  it('classifies RefusalError as INVALID_RESPONSE with its message', () => {
    expect(classifyError(new RefusalError('model refused: no'))).toEqual({
      code: AiAttemptErrorCode.INVALID_RESPONSE,
      message: 'model refused: no',
    });
  });

  it('falls back to UNKNOWN for unrecognized errors', () => {
    expect(classifyError(new Error('weird')).code).toBe(
      AiAttemptErrorCode.UNKNOWN,
    );
  });

  it('captures a message string for the DB column', () => {
    const r = classifyError(new Error('boom'));
    expect(r.message).toContain('boom');
  });
});

describe('failureKind', () => {
  it.each([400, 413, 415, 422])(
    'treats a %i answer as the provider rejecting the request',
    (status) => {
      expect(failureKind({ status })).toBe('rejected');
    },
  );

  it.each([401, 403, 404])(
    'does not blame the image for a %i answer (a configuration problem)',
    (status) => {
      expect(failureKind({ status })).toBe('other');
    },
  );

  it('treats rate limits, 5xx and timeouts as unavailability', () => {
    expect(failureKind({ status: 429 })).toBe('unavailable');
    expect(failureKind({ status: 503 })).toBe('unavailable');
    expect(failureKind(new TimeoutError(100))).toBe('unavailable');
    expect(failureKind(new DeadlineExceededError(100))).toBe('unavailable');
    expect(failureKind(new RetryExhaustedError({ status: 500 }))).toBe(
      'unavailable',
    );
  });

  it('treats connection errors as unavailability', () => {
    expect(
      failureKind(new Anthropic.APIConnectionError({ message: 'reset' })),
    ).toBe('unavailable');
    expect(
      failureKind(new OpenAI.APIConnectionError({ message: 'reset' })),
    ).toBe('unavailable');
  });

  it('treats unusable answers and unknown errors as other', () => {
    expect(failureKind(new InvalidResponseError('bad json'))).toBe('other');
    expect(failureKind(new RefusalError('refused'))).toBe('other');
    expect(failureKind(new Error('boom'))).toBe('other');
  });
});
