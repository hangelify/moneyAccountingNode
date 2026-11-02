import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import {
  AiGatewayExhaustedError,
  AiImageStorageError,
  AiInputInvalidError,
  NoCapableProviderError,
} from '../../ai-gateway/errors';
import type { FailureKind } from '../../ai-gateway/internal/error-classifier';
import { aiErrorBody } from './ai-error-body';

/** Providers are usually back within this time after a 429/5xx/timeout. */
export const AI_UNAVAILABLE_RETRY_AFTER_SEC = 30;

type AiGatewayError =
  | AiGatewayExhaustedError
  | NoCapableProviderError
  | AiInputInvalidError
  | AiImageStorageError;

interface Mapped {
  status: HttpStatus;
  message: string;
  requestId: string | null;
  retryAfterSec?: number;
}

@Catch(
  AiGatewayExhaustedError,
  NoCapableProviderError,
  AiInputInvalidError,
  AiImageStorageError,
)
export class AiGatewayErrorFilter implements ExceptionFilter<AiGatewayError> {
  private readonly log = new Logger(AiGatewayErrorFilter.name);

  catch(exception: AiGatewayError, host: ArgumentsHost): void {
    // Server-side faults nobody else logs: exhaustion is logged by the
    // gateway, a missing provider is reported at boot.
    if (
      exception instanceof AiInputInvalidError ||
      exception instanceof AiImageStorageError
    ) {
      this.log.error(
        `${exception.message}: ${errorText(exception.cause)}`,
        exception.cause instanceof Error ? (exception.cause.stack ?? '') : '',
      );
    }
    const res = host.switchToHttp().getResponse<Response>();
    const m = map(exception);
    if (m.retryAfterSec !== undefined) {
      res.header('Retry-After', String(m.retryAfterSec));
    }
    res.status(m.status).json(aiErrorBody(m.status, m.message, m.requestId));
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function map(e: AiGatewayError): Mapped {
  if (e instanceof NoCapableProviderError) {
    // A configuration gap: retrying soon will not help.
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'Photo recognition is not available',
      requestId: e.requestId,
    };
  }
  if (e instanceof AiInputInvalidError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      message: 'Invalid input for photo recognition',
      requestId: null,
    };
  }
  if (e instanceof AiImageStorageError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'The photo could not be stored, try again later',
      requestId: e.requestId,
      retryAfterSec: AI_UNAVAILABLE_RETRY_AFTER_SEC,
    };
  }
  return mapExhausted(e);
}

function mapExhausted(e: AiGatewayExhaustedError): Mapped {
  const all = (kind: FailureKind) =>
    e.failures.length > 0 && e.failures.every((f) => f === kind);
  if (all('rejected')) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'The image was not accepted for recognition; retake the photo',
      requestId: e.parentId,
    };
  }
  if (all('unavailable')) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'AI providers are unavailable, try again later',
      requestId: e.parentId,
      retryAfterSec: AI_UNAVAILABLE_RETRY_AFTER_SEC,
    };
  }
  return {
    status: HttpStatus.BAD_GATEWAY,
    message: 'AI providers failed',
    requestId: e.parentId,
  };
}
