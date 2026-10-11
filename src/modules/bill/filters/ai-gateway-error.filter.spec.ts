import { Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { AiGatewayErrorFilter } from './ai-gateway-error.filter';
import {
  AiGatewayExhaustedError,
  AiImageStorageError,
  AiInputInvalidError,
  NoCapableProviderError,
} from '../../ai-gateway/errors';
import type { FailureKind } from '../../ai-gateway/internal/error-classifier';

describe('AiGatewayErrorFilter', () => {
  function run(exception: Parameters<AiGatewayErrorFilter['catch']>[0]) {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const header = jest.fn().mockReturnThis();
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status, json, header }) }),
    } as unknown as ArgumentsHost;
    new AiGatewayErrorFilter().catch(exception, host);
    return { status, json, header };
  }

  const exhausted = (failures: FailureKind[]) =>
    new AiGatewayExhaustedError('req-uuid', new Error('last'), failures);

  it('answers 422 when every provider rejected the image', () => {
    const { status, json, header } = run(exhausted(['rejected', 'rejected']));

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: expect.stringMatching(/image.*not accepted.*retake/i) as string,
      request_id: 'req-uuid',
    });
    expect(header).not.toHaveBeenCalled();
  });

  it('answers 503 with Retry-After when every provider was unavailable', () => {
    const { status, json, header } = run(
      exhausted(['unavailable', 'unavailable']),
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(header).toHaveBeenCalledWith('Retry-After', '30');
    expect(json).toHaveBeenCalledWith({
      statusCode: 503,
      error: 'Service Unavailable',
      message: expect.stringMatching(/try again later/i) as string,
      request_id: 'req-uuid',
    });
  });

  it.each<[string, FailureKind[]]>([
    ['rejected + unavailable', ['rejected', 'unavailable']],
    ['an unusable answer', ['other']],
    ['rejected + other', ['rejected', 'other']],
    ['no recorded attempt', []],
  ])('answers 502 for mixed causes: %s', (_label, failures) => {
    const { status, json, header } = run(exhausted(failures));

    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith({
      statusCode: 502,
      error: 'Bad Gateway',
      message: 'AI providers failed',
      request_id: 'req-uuid',
    });
    expect(header).not.toHaveBeenCalled();
  });

  it('answers 503 without Retry-After when no provider can run the task', () => {
    const { status, json, header } = run(
      new NoCapableProviderError('bill.parse', 'req-uuid'),
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Photo recognition is not available',
      request_id: 'req-uuid',
    });
    expect(header).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid task input', new AiInputInvalidError('t', new Error('bad'))],
    ['a storage failure', new AiImageStorageError('req', new Error('S3 down'))],
  ])('logs %s, which no longer reaches the 500 handler', (_label, err) => {
    const logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    run(err);

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(err.message),
      expect.any(String),
    );
    logError.mockRestore();
  });

  it('answers 400 with a null request_id for an invalid task input', () => {
    const { status, json } = run(
      new AiInputInvalidError('bill.parse', new Error('bad input')),
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Invalid input for photo recognition',
      request_id: null,
    });
  });

  it('answers 503 with Retry-After when the image cannot be stored', () => {
    const { status, json, header } = run(
      new AiImageStorageError('req-uuid', new Error('S3 down')),
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(header).toHaveBeenCalledWith('Retry-After', '30');
    expect(json).toHaveBeenCalledWith({
      statusCode: 503,
      error: 'Service Unavailable',
      message: expect.stringMatching(/try again later/i) as string,
      request_id: 'req-uuid',
    });
  });
});
