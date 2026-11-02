import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import {
  AiBudgetExceededError,
  AiCapacityExceededError,
} from '../../ai-gateway/errors';
import { aiErrorBody } from './ai-error-body';

@Catch(AiBudgetExceededError, AiCapacityExceededError)
export class AiUsageLimitFilter implements ExceptionFilter<
  AiBudgetExceededError | AiCapacityExceededError
> {
  catch(
    exception: AiBudgetExceededError | AiCapacityExceededError,
    host: ArgumentsHost,
  ): void {
    const res = host.switchToHttp().getResponse<Response>();
    // Both are refused before the AI request is audited: no request id yet.
    if (exception instanceof AiBudgetExceededError) {
      res
        .status(HttpStatus.TOO_MANY_REQUESTS)
        .json(
          aiErrorBody(HttpStatus.TOO_MANY_REQUESTS, exception.message, null),
        );
      return;
    }
    res.header('Retry-After', String(exception.retryAfterSec));
    res
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .json(
        aiErrorBody(
          HttpStatus.SERVICE_UNAVAILABLE,
          'AI service is busy, try again later',
          null,
        ),
      );
  }
}
