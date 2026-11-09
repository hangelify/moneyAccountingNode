import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { billEventsChannel } from './bill-events.types';
import type { BillEvent } from './bill-events.types';

export const BILL_EVENTS_REDIS = Symbol('BILL_EVENTS_REDIS');

/** Publishes batch progress to `bill-events:{householdId}`. */
@Injectable()
export class BillEventsPublisher implements OnModuleDestroy {
  private readonly log = new Logger(BillEventsPublisher.name);

  constructor(@Inject(BILL_EVENTS_REDIS) private readonly redis: Redis) {}

  // Best effort: the state is in the database and clients refetch on reconnect.
  async publish(householdId: string, event: BillEvent): Promise<void> {
    try {
      await this.redis.publish(
        billEventsChannel(householdId),
        JSON.stringify(event),
      );
    } catch (err) {
      this.log.warn(
        `Could not publish ${event.type} for household ${householdId}: ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
