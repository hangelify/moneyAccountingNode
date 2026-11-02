import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { BILL_EVENTS_PATTERN, householdOfChannel } from './bill-events.types';
import type { BillEvent } from './bill-events.types';

/** The part of an ioredis connection the hub uses. */
export interface BillEventsSubscriber {
  psubscribe(pattern: string): Promise<unknown>;
  on(
    event: 'pmessage',
    listener: (pattern: string, channel: string, message: string) => void,
  ): unknown;
  quit(): Promise<unknown>;
}

export const BILL_EVENTS_SUBSCRIBER_FACTORY = Symbol(
  'BILL_EVENTS_SUBSCRIBER_FACTORY',
);
export type BillEventsSubscriberFactory = () => BillEventsSubscriber;

/**
 * Fans the `bill-events:*` channels out to SSE streams. One subscriber
 * connection per process, opened by the first stream; one Subject per
 * household that has listeners.
 */
@Injectable()
export class BillEventsHub implements OnModuleDestroy {
  private readonly log = new Logger(BillEventsHub.name);
  private subscriber?: BillEventsSubscriber;
  private readonly subjects = new Map<string, Subject<BillEvent>>();

  constructor(
    @Inject(BILL_EVENTS_SUBSCRIBER_FACTORY)
    private readonly createSubscriber: BillEventsSubscriberFactory,
  ) {}

  stream(householdId: string): Observable<BillEvent> {
    return new Observable<BillEvent>((observer) => {
      this.connect();
      let subject = this.subjects.get(householdId);
      if (!subject) {
        subject = new Subject<BillEvent>();
        this.subjects.set(householdId, subject);
      }
      const own = subject;
      const sub = own.subscribe(observer);
      return () => {
        sub.unsubscribe();
        if (!own.observed && this.subjects.get(householdId) === own) {
          this.subjects.delete(householdId);
        }
      };
    });
  }

  /** Households with at least one open stream. */
  listenedHouseholds(): string[] {
    return [...this.subjects.keys()];
  }

  async onModuleDestroy(): Promise<void> {
    for (const subject of this.subjects.values()) subject.complete();
    this.subjects.clear();
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    await subscriber?.quit().catch(() => undefined);
  }

  private connect(): void {
    if (this.subscriber) return;
    const subscriber = this.createSubscriber();
    this.subscriber = subscriber;
    subscriber.on('pmessage', (_pattern, channel, message) =>
      this.dispatch(channel, message),
    );
    // ioredis re-subscribes by itself after a reconnect.
    subscriber
      .psubscribe(BILL_EVENTS_PATTERN)
      .catch((err: Error) =>
        this.log.warn(`Could not subscribe to bill events: ${err.message}`),
      );
  }

  private dispatch(channel: string, message: string): void {
    const householdId = householdOfChannel(channel);
    const subject = householdId ? this.subjects.get(householdId) : undefined;
    if (!subject) return;
    let event: BillEvent;
    try {
      event = JSON.parse(message) as BillEvent;
    } catch {
      this.log.warn(`Dropped a malformed message on ${channel}`);
      return;
    }
    subject.next(event);
  }
}
