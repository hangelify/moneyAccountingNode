import {
  HttpException,
  Logger,
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { AiHttpExceptionFilter } from './ai-http-exception.filter';

describe('AiHttpExceptionFilter', () => {
  function run(exception: HttpException) {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status, json }),
        getRequest: () => ({ method: 'POST', route: { path: '/x' } }),
      }),
    } as unknown as ArgumentsHost;
    new AiHttpExceptionFilter().catch(exception, host);
    return { status, json };
  }

  it('gives a plain HTTP error the AI error shape with a null request_id', () => {
    const { status, json } = run(
      new UnsupportedMediaTypeException('Not an image'),
    );

    expect(status).toHaveBeenCalledWith(415);
    expect(json).toHaveBeenCalledWith({
      statusCode: 415,
      error: 'Unsupported Media Type',
      message: 'Not an image',
      request_id: null,
    });
  });

  it('handles an exception built from a bare string response', () => {
    const { json } = run(new HttpException('Too big', 413));

    expect(json).toHaveBeenCalledWith({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 'Too big',
      request_id: null,
    });
  });

  it('maps the per-user throttler 429', () => {
    const { status, json } = run(new ThrottlerException());

    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 429,
        error: 'Too Many Requests',
        request_id: null,
      }),
    );
  });

  it('joins a list of validation messages', () => {
    const { json } = run(new PayloadTooLargeException({ message: ['a', 'b'] }));

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'a; b' }),
    );
  });

  it('keeps the request id and extra fields of a body that has them', () => {
    const parsed = { items: [] };
    const { json } = run(
      new UnprocessableEntityException({
        statusCode: 422,
        message: 'draft not saved',
        request_id: 'req-1',
        parsed,
      }),
    );

    expect(json).toHaveBeenCalledWith({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'draft not saved',
      request_id: 'req-1',
      parsed,
    });
  });

  it('logs 5xx HTTP errors like the global filter does', () => {
    const logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    run(new HttpException('upstream broke', 500));

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('upstream broke'),
      expect.anything(),
    );
    logError.mockRestore();
  });
});
