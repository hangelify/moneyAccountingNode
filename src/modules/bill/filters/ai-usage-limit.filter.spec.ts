import type { ArgumentsHost } from '@nestjs/common';
import { AiUsageLimitFilter } from './ai-usage-limit.filter';
import {
  AiBudgetExceededError,
  AiCapacityExceededError,
} from '../../ai-gateway/errors';

describe('AiUsageLimitFilter', () => {
  function makeHost() {
    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const header = jest.fn().mockReturnThis();
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status, json, header }) }),
    } as unknown as ArgumentsHost;
    return { host, status, json, header };
  }

  it('maps AiBudgetExceededError to 429 with a budget message', () => {
    const { host, status, json } = makeHost();

    new AiUsageLimitFilter().catch(new AiBudgetExceededError(1.2, 1), host);

    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith({
      statusCode: 429,
      message:
        'Daily AI budget exceeded: spent $1.20 of $1.00 in the last 24 hours',
    });
  });

  it('maps AiCapacityExceededError to 503 with Retry-After', () => {
    const { host, status, json, header } = makeHost();

    new AiUsageLimitFilter().catch(new AiCapacityExceededError(4, 10), host);

    expect(header).toHaveBeenCalledWith('Retry-After', '10');
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      statusCode: 503,
      message: 'AI service is busy, try again later',
    });
  });
});
