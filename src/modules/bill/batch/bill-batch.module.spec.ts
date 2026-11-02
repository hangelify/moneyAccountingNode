import { BillBatchModule } from './bill-batch.module';
import { BILL_BATCH_DISABLED, BILL_BATCH_ENV } from './bill-batch.env';
import { BillBatchService } from './bill-batch.service';
import { BillEventsHub } from './bill-events.hub';
import { BillPhotoProcessor } from './bill-photo.processor';

describe('BillBatchModule.register', () => {
  const saved = process.env.BILL_BATCH_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.BILL_BATCH_ENABLED;
    else process.env.BILL_BATCH_ENABLED = saved;
  });

  it('provides only the disabled flag when BILL_BATCH_ENABLED=false', () => {
    process.env.BILL_BATCH_ENABLED = 'false';
    const mod = BillBatchModule.register();
    expect(mod.imports ?? []).toEqual([]);
    const tokens = (mod.providers ?? []).map((p) =>
      typeof p === 'function' ? p : p.provide,
    );
    expect(tokens).toEqual([BILL_BATCH_ENV, BILL_BATCH_DISABLED]);
  });

  it('registers the queue, worker, hub and service when enabled', () => {
    process.env.BILL_BATCH_ENABLED = 'true';
    const mod = BillBatchModule.register();
    expect(mod.exports).toEqual(
      expect.arrayContaining([BillBatchService, BillEventsHub, BILL_BATCH_ENV]),
    );
    expect(mod.exports).not.toContain(BILL_BATCH_DISABLED);
    expect(mod.providers).toContain(BillPhotoProcessor);
  });
});
