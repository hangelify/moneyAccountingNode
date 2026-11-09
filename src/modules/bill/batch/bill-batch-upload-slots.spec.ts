import { EventEmitter } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';
import {
  BillBatchBusyError,
  BillBatchUploadSlotGuard,
} from './bill-batch-upload-slots';
import type { BillBatchEnv } from './bill-batch.env';

type FakeRes = EventEmitter & {
  destroyed: boolean;
  closed: boolean;
  writableFinished: boolean;
};

function exchange(state: Partial<FakeRes> = {}, reqDestroyed = false) {
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    closed: false,
    writableFinished: false,
    ...state,
  });
  const req = { destroyed: reqDestroyed };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, res };
}

describe('BillBatchUploadSlotGuard', () => {
  const guard = () =>
    new BillBatchUploadSlotGuard({ maxConcurrentUploads: 2 } as BillBatchEnv);

  it('takes a slot and releases it once on finish and close', () => {
    const g = guard();
    const { ctx, res } = exchange();
    expect(g.canActivate(ctx)).toBe(true);
    expect(g.inUseCount).toBe(1);
    res.emit('finish');
    res.emit('close');
    expect(g.inUseCount).toBe(0);
  });

  it('refuses a third request with BillBatchBusyError', () => {
    const g = guard();
    g.canActivate(exchange().ctx);
    g.canActivate(exchange().ctx);
    expect(() => g.canActivate(exchange().ctx)).toThrow(BillBatchBusyError);
  });

  it.each([
    [{ destroyed: true, closed: true }, false],
    [{ closed: true }, false],
    [{ writableFinished: true }, false],
    [{}, true],
  ])(
    'takes no slot for a response already closed (%j, request destroyed: %p)',
    (state, reqDestroyed) => {
      const g = guard();
      const { ctx } = exchange(state, reqDestroyed);
      expect(g.canActivate(ctx)).toBe(false);
      expect(g.inUseCount).toBe(0);
    },
  );

  it('two early aborts do not block a following upload', () => {
    const g = guard();
    for (let i = 0; i < 2; i++) {
      // 'close' fired before the guard ran; nothing is emitted afterwards.
      const { ctx } = exchange({ destroyed: true, closed: true });
      expect(g.canActivate(ctx)).toBe(false);
    }
    expect(g.canActivate(exchange().ctx)).toBe(true);
    expect(g.canActivate(exchange().ctx)).toBe(true);
    expect(g.inUseCount).toBe(2);
  });
});
