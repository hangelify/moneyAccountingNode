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

@Catch(AiBudgetExceededError, AiCapacityExceededError)
export class AiUsageLimitFilter implements ExceptionFilter<
  AiBudgetExceededError | AiCapacityExceededError
> {
  catch(
    exception: AiBudgetExceededError | AiCapacityExceededError,
    host: ArgumentsHost,
  ): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof AiBudgetExceededError) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).json({
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: exception.message,
      });
      return;
    }
    res.header('Retry-After', String(exception.retryAfterSec));
    res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'AI service is busy, try again later',
    });
  }
}
