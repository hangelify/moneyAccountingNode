import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Bill } from '../../entities/bill.entity';
import { BillStatus } from '../../types/bill-status.enum';
import { DRAFT_RETENTION_DAYS } from './draft-cleanup.env';

const DAY_MS = 86_400_000;

/** Soft-deletes AI drafts nobody confirmed within the retention period. */
@Injectable()
export class DraftCleanupService {
  private readonly log = new Logger(DraftCleanupService.name);

  constructor(
    private readonly em: EntityManager,
    @Inject(DRAFT_RETENTION_DAYS) private readonly retentionDays: number,
  ) {}

  // The UPDATE is idempotent, so several app instances may run it at once.
  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'purge-stale-drafts',
    timeZone: 'UTC',
  })
  async runScheduled(): Promise<void> {
    try {
      const purged = await this.purgeStaleDrafts();
      if (purged > 0) this.log.log(`Deleted ${purged} stale draft bill(s)`);
    } catch (err) {
      this.log.error(
        'Deleting stale draft bills failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  async purgeStaleDrafts(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.retentionDays * DAY_MS);
    return this.em.fork().nativeUpdate(
      Bill,
      {
        status: BillStatus.DRAFT,
        deleted_at: null,
        created_at: { $lt: cutoff },
      },
      { deleted_at: now, updated_at: now },
    );
  }
}
