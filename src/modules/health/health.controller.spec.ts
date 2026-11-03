import type { EntityManager } from '@mikro-orm/core';
import type { Response } from 'express';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let execute: jest.Mock;
  let controller: HealthController;
  let res: { status: jest.Mock };

  beforeEach(() => {
    execute = jest.fn();
    const em = { getConnection: () => ({ execute }) };
    controller = new HealthController(em as unknown as EntityManager);
    res = { status: jest.fn() };
  });

  it('health returns 200 when db is up', async () => {
    execute.mockResolvedValue([{ '?column?': 1 }]);

    const body = await controller.check(res as unknown as Response);

    expect(body).toEqual({ status: 'ok' });
    expect(res.status).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith('select 1');
  });

  it('health returns 503 when db query fails', async () => {
    execute.mockRejectedValue(
      new Error('password authentication failed for user "budget"'),
    );

    const body = await controller.check(res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('health returns 503 when db does not answer within 1 s', async () => {
    jest.useFakeTimers();
    execute.mockReturnValue(new Promise(() => undefined));

    const pending = controller.check(res as unknown as Response);
    await jest.advanceTimersByTimeAsync(1_000);
    const body = await pending;

    expect(res.status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ status: 'unavailable' });
    jest.useRealTimers();
  });
});
