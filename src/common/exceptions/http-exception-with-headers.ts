import { HttpException } from '@nestjs/common';

/** An HttpException whose response must also carry headers. */
export class HttpExceptionWithHeaders extends HttpException {
  constructor(
    response: string | Record<string, unknown>,
    status: number,
    readonly headers: Readonly<Record<string, string>>,
  ) {
    super(response, status);
  }
}
