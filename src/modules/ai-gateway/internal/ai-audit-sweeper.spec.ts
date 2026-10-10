import { Logger } from '@nestjs/common';
import { AiAuditSweeper, staleAfterMs } from './ai-audit-sweeper';
import type { AiRequestLogger } from './ai-request-logger';
import { testAiCallConfig } from '../providers/__fixtures__/call-bounds.shared';

describe('AiAuditSweeper', () => {
  let failStalePending: jest.Mock;
  let sweeper: AiAuditSweeper;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-10T12:00:00Z') });
    failStalePending = jest
      .fn()
      .mockResolvedValue({ requests: 0, attempts: 0 });
    sweeper = new AiAuditSweeper(
      { failStalePending } as unknown as AiRequestLogger,
      testAiCallConfig({ taskDeadlineMs: 90_000 }),
    );
  });

  afterEach(() => {
    sweeper.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('waits well past the task deadline before calling a row stale', () => {
    expect(staleAfterMs(90_000)).toBe(15 * 60_000);
    expect(staleAfterMs(20 * 60_000)).toBe(40 * 60_000);
  });

  it('sweeps at startup and then periodically', async () => {
    sweeper.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(failStalePending).toHaveBeenCalledTimes(1);
    expect(failStalePending).toHaveBeenCalledWith(
      new Date(Date.now() - 15 * 60_000),
    );

    await jest.advanceTimersByTimeAsync(15 * 60_000);
    expect(failStalePending).toHaveBeenCalledTimes(2);
  });

  it('logs a failed sweep instead of throwing', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    failStalePending.mockRejectedValueOnce(new Error('db down'));

    sweeper.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('db down'),
      expect.anything(),
    );
  });

  it('stops sweeping on shutdown', async () => {
    sweeper.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    sweeper.onModuleDestroy();

    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(failStalePending).toHaveBeenCalledTimes(1);
  });
});
