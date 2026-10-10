import { AiAttemptErrorCode } from '../../../entities/ai-request-attempt.entity';
import {
  DeadlineExceededError,
  RetryExhaustedError,
  TimeoutError,
} from './retry';

export class InvalidResponseError extends Error {
  constructor(
    message: string,
    public readonly raw?: string,
  ) {
    super(message);
    this.name = 'InvalidResponseError';
  }
}

export interface ClassifiedError {
  code: AiAttemptErrorCode;
  message: string;
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const anyErr = err as { status?: number; statusCode?: number };
    return anyErr.status ?? anyErr.statusCode;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof TimeoutError || err instanceof DeadlineExceededError) {
    return { code: AiAttemptErrorCode.TIMEOUT, message: err.message };
  }
  if (err instanceof InvalidResponseError) {
    return { code: AiAttemptErrorCode.INVALID_RESPONSE, message: err.message };
  }
  if (err instanceof RetryExhaustedError) {
    return classifyError(err.cause);
  }
  const status = statusOf(err);
  if (status === 429) {
    return { code: AiAttemptErrorCode.RATE_LIMIT, message: messageOf(err) };
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return { code: AiAttemptErrorCode.SERVER_ERROR, message: messageOf(err) };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { code: AiAttemptErrorCode.PROVIDER_ERROR, message: messageOf(err) };
  }
  return { code: AiAttemptErrorCode.UNKNOWN, message: messageOf(err) };
}
