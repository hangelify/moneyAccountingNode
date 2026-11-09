import {
  ArgumentsHost,
  CanActivate,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import type { Response } from 'express';
import { aiErrorBody } from '../filters/ai-error-body';
import { BILL_BATCH_DISABLED } from './bill-batch.env';

const BATCH_DISABLED_MESSAGE = 'Batch photo parsing is disabled';

/**
 * Not an HttpException on purpose: the AI filters and the global filter log
 * every 5xx HttpException as an error, and a client that keeps reconnecting
 * to the event stream would fill the log. BillBatchDisabledFilter answers it.
 */
export class BillBatchDisabledError extends Error {
  constructor() {
    super(BATCH_DISABLED_MESSAGE);
  }
}

@Catch(BillBatchDisabledError)
export class BillBatchDisabledFilter implements ExceptionFilter<BillBatchDisabledError> {
  catch(exception: BillBatchDisabledError, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .json(
        aiErrorBody(HttpStatus.SERVICE_UNAVAILABLE, exception.message, null),
      );
  }
}

/**
 * Refuses the batch routes when BILL_BATCH_ENABLED=false. Listed before
 * UserThrottlerGuard and the upload interceptor, so a refused request
 * neither counts against the AI limits nor gets its files buffered.
 */
@Injectable()
export class BillBatchEnabledGuard implements CanActivate {
  constructor(
    @Optional()
    @Inject(BILL_BATCH_DISABLED)
    private readonly disabled?: boolean,
  ) {}

  canActivate(): boolean {
    if (this.disabled) throw new BillBatchDisabledError();
    return true;
  }
}
