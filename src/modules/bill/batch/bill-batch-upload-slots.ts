import {
  ArgumentsHost,
  CanActivate,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import type { Response } from 'express';
import { aiErrorBody } from '../filters/ai-error-body';
import { BILL_BATCH_ENV } from './bill-batch.env';
import type { BillBatchEnv } from './bill-batch.env';

const BUSY_MESSAGE = 'Too many batch uploads in progress, try again shortly';
const BUSY_RETRY_AFTER_SEC = 5;
const DEFAULT_MAX_CONCURRENT_UPLOADS = 2;

/**
 * Not an HttpException, like BillBatchDisabledError: the AI filters log every
 * 5xx HttpException as an error, and a busy server is not one.
 */
export class BillBatchBusyError extends Error {
  constructor() {
    super(BUSY_MESSAGE);
  }
}

@Catch(BillBatchBusyError)
export class BillBatchBusyFilter implements ExceptionFilter<BillBatchBusyError> {
  catch(exception: BillBatchBusyError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .header('Retry-After', String(BUSY_RETRY_AFTER_SEC))
      .json(
        aiErrorBody(HttpStatus.SERVICE_UNAVAILABLE, exception.message, null),
      );
  }
}

/**
 * Caps the `parse-photos` requests this process handles at once
 * (BILL_BATCH_MAX_CONCURRENT_UPLOADS): multer buffers every file in memory.
 * A guard runs before the upload interceptor, so a refused request is not
 * buffered; listed before UserThrottlerGuard, it costs no AI quota either.
 * The slot is released once the response finishes or the connection closes,
 * whatever the outcome.
 */
@Injectable()
export class BillBatchUploadSlotGuard implements CanActivate {
  private inUse = 0;
  private readonly max: number;

  constructor(@Optional() @Inject(BILL_BATCH_ENV) env?: BillBatchEnv) {
    this.max = env?.maxConcurrentUploads ?? DEFAULT_MAX_CONCURRENT_UPLOADS;
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.inUse >= this.max) throw new BillBatchBusyError();
    this.inUse++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.inUse--;
    };
    const res = context.switchToHttp().getResponse<Response>();
    res.once('finish', release);
    res.once('close', release);
    return true;
  }
}
