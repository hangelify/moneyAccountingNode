import {
  HttpException,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import {
  DriverException,
  ForeignKeyConstraintViolationException,
  NotFoundError,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { HttpExceptionWithHeaders } from '../exceptions/http-exception-with-headers';

function makeHost(method: string, routePath?: string, originalUrl = '/x') {
  const status = jest.fn().mockReturnThis();
  const json = jest.fn();
  const setHeader = jest.fn();
  const response = { status, json, setHeader };
  const request = {
    method,
    originalUrl,
    route: routePath ? { path: routePath } : undefined,
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json, setHeader };
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let loggerErrorSpy: jest.SpyInstance;
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    loggerWarnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the headers an HttpException carries', () => {
    const { host, status, json, setHeader } = makeHost('GET', '/auth/me');
    const err = new HttpExceptionWithHeaders(
      { statusCode: 401, message: 'Unauthorized' },
      401,
      { 'WWW-Authenticate': 'Bearer realm="api"' },
    );

    filter.catch(err, host);

    expect(setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer realm="api"',
    );
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      statusCode: 401,
      message: 'Unauthorized',
    });
  });

  it('logs and returns 500 for a non-HttpException Error', () => {
    const { host, status, json } = makeHost('POST', '/bills/parse-photo');
    const err = new Error('something exploded');

    filter.catch(err, host);

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      '[POST /bills/parse-photo] something exploded',
      err.stack,
    );
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
    });
  });

  it('logs with coerced message and no stack for a non-Error thrown value', () => {
    const { host, status, json } = makeHost('GET', '/users/me');

    filter.catch('oops', host);

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      '[GET /users/me] oops',
      undefined,
    );
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'Internal server error',
    });
  });

  it('logs the route pattern, not the URL, so path tokens stay out of logs', () => {
    const { host } = makeHost(
      'POST',
      '/households/invites/:token/accept',
      '/households/invites/secret-invite-token/accept',
    );

    filter.catch(new Error('boom'), host);

    const [message] = loggerErrorSpy.mock.calls[0] as [string];
    expect(message).toBe('[POST /households/invites/:token/accept] boom');
    expect(message).not.toContain('secret-invite-token');
  });

  it('logs an unmatched route without the URL', () => {
    const { host } = makeHost('GET', undefined, '/no/such/route?token=abc');

    filter.catch(new Error('boom'), host);

    const [message] = loggerErrorSpy.mock.calls[0] as [string];
    expect(message).toBe('[GET <unknown route>] boom');
  });

  it('passes HttpException with string response through without logging', () => {
    const { host, status, json } = makeHost('GET', '/protected');
    const err = new HttpException('Forbidden', 403);

    filter.catch(err, host);

    expect(loggerErrorSpy).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      statusCode: 403,
      message: 'Forbidden',
    });
  });

  it('passes HttpException with object response through without logging', () => {
    const { host, status, json } = makeHost('POST', '/auth/login');
    const err = new BadRequestException({
      statusCode: 400,
      message: 'Bad input',
      error: 'Bad Request',
    });

    filter.catch(err, host);

    expect(loggerErrorSpy).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      message: 'Bad input',
      error: 'Bad Request',
    });
  });

  it('logs HttpException with a 5xx status with its stack', () => {
    const { host, status, json } = makeHost('GET', '/users/me');
    const err = new InternalServerErrorException('db is down');

    filter.catch(err, host);

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      '[GET /users/me] db is down',
      err.stack,
    );
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      message: 'db is down',
      error: 'Internal Server Error',
    });
  });

  describe('ORM errors', () => {
    it('warns with the error class and route, not the driver message', () => {
      const { host } = makeHost('POST', '/auth/register');
      const err = new UniqueConstraintViolationException(
        pgError('23505', 'Key (email)=(alice@example.com) already exists'),
      );

      filter.catch(err, host);

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        '[POST /auth/register] UniqueConstraintViolationException -> 409',
      );
    });

    it('maps UniqueConstraintViolationException to 409', () => {
      const { host, status, json } = makeHost('POST', '/auth/register');
      const err = new UniqueConstraintViolationException(
        pgError('23505', 'duplicate key value violates unique constraint'),
      );

      filter.catch(err, host);

      expect(loggerErrorSpy).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith({
        statusCode: 409,
        message: 'Conflict',
        error: 'Conflict',
      });
    });

    it('maps ForeignKeyConstraintViolationException to 409', () => {
      const { host, status, json } = makeHost('DELETE', '/x/:id');
      const err = new ForeignKeyConstraintViolationException(
        pgError('23503', 'violates foreign key constraint'),
      );

      filter.catch(err, host);

      expect(loggerErrorSpy).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(409);
      expect(json).toHaveBeenCalledWith({
        statusCode: 409,
        message: 'Conflict',
        error: 'Conflict',
      });
    });

    it('maps NotFoundError to 404 without leaking the query', () => {
      const { host, status, json } = makeHost('GET', '/users/me');
      const err = NotFoundError.findOneFailed('User', { id: 'u-1' });

      filter.catch(err, host);

      expect(loggerErrorSpy).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(404);
      expect(json).toHaveBeenCalledWith({
        statusCode: 404,
        message: 'Not found',
        error: 'Not Found',
      });
    });

    it('maps DriverException with code 22P02 (invalid input syntax) to 400', () => {
      const { host, status, json } = makeHost('GET', '/x/:id');
      const err = new DriverException(
        pgError('22P02', 'invalid input syntax for type uuid: "abc"'),
      );

      filter.catch(err, host);

      expect(loggerErrorSpy).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        statusCode: 400,
        message: 'Bad request',
        error: 'Bad Request',
      });
    });

    it('keeps any other DriverException a logged 500', () => {
      const { host, status } = makeHost('GET', '/x/:id');
      const err = new DriverException(pgError('53300', 'too many connections'));

      filter.catch(err, host);

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        '[GET /x/:id] too many connections',
        err.stack,
      );
      expect(status).toHaveBeenCalledWith(500);
    });
  });
});
