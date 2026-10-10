import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  DriverException,
  ForeignKeyConstraintViolationException,
  NotFoundError,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { Request, Response } from 'express';

// Postgres "invalid_text_representation", e.g. a malformed uuid.
const PG_INVALID_TEXT_REPRESENTATION = '22P02';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('UnhandledException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const body =
        typeof response === 'string'
          ? { statusCode: status, message: response }
          : response;
      if (status >= 500) this.logError(req, exception);
      res.status(status).json(body);
      return;
    }

    const mapped = mapOrmError(exception);
    if (mapped) {
      // Mapped ORM errors may also hide server bugs (an FK violation on an
      // insert, a findOneOrFail on an invariant), so they are not silent.
      // Only the class name: the driver message may carry query values.
      this.logger.warn(
        `[${req.method} ${routeOf(req)}] ${(exception as Error).name} -> ${mapped.status}`,
      );
      res.status(mapped.status).json({
        statusCode: mapped.status,
        message: mapped.message,
        error: mapped.error,
      });
      return;
    }

    this.logError(req, exception);
    res.status(500).json({
      statusCode: 500,
      message: 'Internal server error',
    });
  }

  // Logs the route pattern, never the URL: path params may carry secrets
  // (e.g. an invite token).
  private logError(req: Request, exception: unknown): void {
    const message =
      exception instanceof Error ? exception.message : String(exception);
    const stack = exception instanceof Error ? exception.stack : undefined;

    this.logger.error(`[${req.method} ${routeOf(req)}] ${message}`, stack);
  }
}

function routeOf(req: Request): string {
  return (
    (req.route as { path?: string } | undefined)?.path ?? '<unknown route>'
  );
}

// Client errors the ORM reports. The ORM's message is not passed on: it
// carries SQL, constraint names and query values.
function mapOrmError(
  exception: unknown,
): { status: HttpStatus; message: string; error: string } | null {
  if (
    exception instanceof UniqueConstraintViolationException ||
    exception instanceof ForeignKeyConstraintViolationException
  ) {
    return {
      status: HttpStatus.CONFLICT,
      message: 'Conflict',
      error: 'Conflict',
    };
  }
  if (exception instanceof NotFoundError) {
    return {
      status: HttpStatus.NOT_FOUND,
      message: 'Not found',
      error: 'Not Found',
    };
  }
  if (
    exception instanceof DriverException &&
    exception.code === PG_INVALID_TEXT_REPRESENTATION
  ) {
    return {
      status: HttpStatus.BAD_REQUEST,
      message: 'Bad request',
      error: 'Bad Request',
    };
  }
  return null;
}
