import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  classifyError,
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
