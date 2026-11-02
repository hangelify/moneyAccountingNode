import { BillEventsHub } from './bill-events.hub';
import type { BillEventsSubscriber } from './bill-events.hub';
import type { BillEvent } from './bill-events.types';
import { BillBatchItemStatus } from '../../../types/bill-batch-item-status.enum';

class FakeSubscriber implements BillEventsSubscriber {
  patterns: string[] = [];
  quitCalls = 0;
  private listener?: (
    pattern: string,
    channel: string,
    message: string,
  ) => void;

  psubscribe(pattern: string): Promise<unknown> {
    this.patterns.push(pattern);
    return Promise.resolve(1);
  }

  on(
    _event: 'pmessage',
    listener: (pattern: string, channel: string, message: string) => void,
  ): unknown {
    this.listener = listener;
    return this;
  }

  quit(): Promise<unknown> {
    this.quitCalls++;
    return Promise.resolve('OK');
  }

  emit(channel: string, message: string): void {
    this.listener?.('bill-events:*', channel, message);
  }
}

const event = (batchId: string): BillEvent => ({
  type: 'item.processing',
  data: {
    batch_id: batchId,
    item_id: 'item-1',
    position: 0,
    status: BillBatchItemStatus.PROCESSING,
    created_by_user_id: 'user-1',
  },
});

describe('BillEventsHub', () => {
  let fake: FakeSubscriber;
  let created: number;
  let hub: BillEventsHub;

  beforeEach(() => {
    fake = new FakeSubscriber();
    created = 0;
    hub = new BillEventsHub(() => {
      created++;
      return fake;
    });
  });

  it('opens no connection until the first stream', () => {
    expect(created).toBe(0);
  });

  it('sends events only to listeners of the matching household', () => {
    const a: BillEvent[] = [];
    const b: BillEvent[] = [];
    hub.stream('h-a').subscribe((e) => a.push(e));
    hub.stream('h-b').subscribe((e) => b.push(e));

    fake.emit('bill-events:h-a', JSON.stringify(event('batch-a')));

    expect(a).toEqual([event('batch-a')]);
    expect(b).toEqual([]);
    expect(created).toBe(1);
    expect(fake.patterns).toEqual(['bill-events:*']);
  });

  it('drops the household subject when its last listener leaves', () => {
    const seen: BillEvent[] = [];
    const s1 = hub.stream('h-a').subscribe((e) => seen.push(e));
    const s2 = hub.stream('h-a').subscribe((e) => seen.push(e));

    s1.unsubscribe();
    expect(hub.listenedHouseholds()).toEqual(['h-a']);
    s2.unsubscribe();
    expect(hub.listenedHouseholds()).toEqual([]);

    fake.emit('bill-events:h-a', JSON.stringify(event('batch-a')));
    expect(seen).toEqual([]);
  });

  it('ignores malformed messages', () => {
    const seen: BillEvent[] = [];
    hub.stream('h-a').subscribe((e) => seen.push(e));
    fake.emit('bill-events:h-a', '{not json');
    fake.emit('bill-events:h-a', JSON.stringify(event('batch-a')));
    expect(seen).toEqual([event('batch-a')]);
  });

  it('closes the connection and completes streams on shutdown', async () => {
    let completed = false;
    hub.stream('h-a').subscribe({ complete: () => (completed = true) });
    await hub.onModuleDestroy();
    expect(fake.quitCalls).toBe(1);
    expect(completed).toBe(true);
  });
});
