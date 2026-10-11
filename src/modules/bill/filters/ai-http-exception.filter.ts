import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { aiErrorBody } from './ai-error-body';

/**
 * Gives every HTTP error of an AI endpoint (auth, throttling, upload checks)
 * the same body as the AI errors, so clients read one shape. Fields already
 * in the body, such as `request_id` and `parsed`, are kept.
 */
@Catch(HttpException)
export class AiHttpExceptionFilter implements ExceptionFilter<HttpException> {
  private readonly log = new Logger(AiHttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const response = exception.getResponse();
    const fields: Record<string, unknown> =
      typeof response === 'string' ? { message: response } : { ...response };

    if (status >= 500) {
      const req = ctx.getRequest<Request>();
      const route =
        (req.route as { path?: string } | undefined)?.path ?? '<unknown route>';
      this.log.error(
        `[${req.method} ${route}] ${exception.message}`,
        exception.stack,
      );
    }

    res.status(status).json({
      ...fields,
      ...aiErrorBody(
        status,
        messageOf(fields.message, exception.message),
        typeof fields.request_id === 'string' ? fields.request_id : null,
      ),
    });
  }
}

function messageOf(message: unknown, fallback: string): string {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  return fallback;
}
