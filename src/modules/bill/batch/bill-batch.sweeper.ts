import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BillBatchService } from './bill-batch.service';

/**
 * Periodically fails batch items stuck `queued`/`processing` with no job left
 * to finish them (see BillBatchService.sweepStaleItems). Registered only when
 * the batch is enabled.
 */
@Injectable()
export class BillBatchSweeper {
  private readonly log = new Logger(BillBatchSweeper.name);

  constructor(private readonly batches: BillBatchService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'sweep-stale-batch-items' })
  async runScheduled(): Promise<void> {
    try {
      const failed = await this.batches.sweepStaleItems();
      if (failed > 0) this.log.warn(`Failed ${failed} stuck batch item(s)`);
    } catch (err) {
      this.log.error(
        'Sweeping stuck batch items failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
