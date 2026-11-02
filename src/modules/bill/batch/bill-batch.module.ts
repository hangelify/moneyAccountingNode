import { DynamicModule, Logger, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import Redis from 'ioredis';
import { redisConnectionOptions } from '../../../config/redis';
import { Bill } from '../../../entities/bill.entity';
import { BillBatch } from '../../../entities/bill-batch.entity';
import { BillBatchItem } from '../../../entities/bill-batch-item.entity';
import { StorageModule } from '../../storage/storage.module';
import { BillModule } from '../bill.module';
import {
  BILL_BATCH_DISABLED,
  BILL_BATCH_ENV,
  BILL_PHOTO_QUEUE,
  readBillBatchEnv,
} from './bill-batch.env';
import { BillBatchService } from './bill-batch.service';
import {
  BILL_EVENTS_REDIS,
  BillEventsPublisher,
} from './bill-events.publisher';
import {
  BILL_EVENTS_SUBSCRIBER_FACTORY,
  BillEventsHub,
} from './bill-events.hub';

const log = new Logger('BillBatchModule');

function eventsRedis(maxRetriesPerRequest: number | null): Redis {
  const redis = new Redis({
    ...redisConnectionOptions(),
    maxRetriesPerRequest,
  });
  redis.on('error', (err: Error) => log.warn(err.message));
  return redis;
}

/**
 * Batch photo parsing: the BullMQ queue, events and BillBatchService. With
 * BILL_BATCH_ENABLED=false nothing touches Redis; only BILL_BATCH_DISABLED is
 * provided and the batch endpoints answer 503.
 */
@Module({})
export class BillBatchModule {
  static register(): DynamicModule {
    const env = readBillBatchEnv();
    const envProvider = { provide: BILL_BATCH_ENV, useValue: env };
    if (!env.enabled) {
      return {
        module: BillBatchModule,
        providers: [
          envProvider,
          { provide: BILL_BATCH_DISABLED, useValue: true },
        ],
        exports: [BILL_BATCH_ENV, BILL_BATCH_DISABLED],
      };
    }
    return {
      module: BillBatchModule,
      imports: [
        BullModule.forRoot({
          connection: {
            ...redisConnectionOptions(),
            maxRetriesPerRequest: null,
          },
        }),
        BullModule.registerQueue({ name: BILL_PHOTO_QUEUE }),
        MikroOrmModule.forFeature([Bill, BillBatch, BillBatchItem]),
        StorageModule,
        BillModule,
      ],
      providers: [
        envProvider,
        // Publishing is best effort: fail fast rather than hold a worker.
        { provide: BILL_EVENTS_REDIS, useFactory: () => eventsRedis(1) },
        // The subscription waits out a Redis outage instead of failing.
        {
          provide: BILL_EVENTS_SUBSCRIBER_FACTORY,
          useValue: () => eventsRedis(null),
        },
        BillEventsPublisher,
        BillEventsHub,
        BillBatchService,
      ],
      exports: [
        BILL_BATCH_ENV,
        BillEventsPublisher,
        BillEventsHub,
        BillBatchService,
      ],
    };
  }
}
