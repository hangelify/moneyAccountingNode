import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/core';
import { Bill } from '../../entities/bill.entity';
import { BillStatus } from '../../types/bill-status.enum';
import type { Currency } from '../../types/currency.enum';
import {
  rankCandidates,
  type CandidateRow,
  type DuplicateProbe,
} from './bill-duplicates';
import { PossibleDuplicateDto } from './dto/bill-duplicates.dto';

interface RawCandidate {
  id: string;
  amount: string;
  currency: Currency | null;
  bill_date: string;
  market_id: string | null;
  market_name: string | null;
  fiscal_register_id: string | null;
  fiscal_receipt_number: string | null;
  purchase_time: string | null;
  created_at: string;
  created_by_name: string | null;
}

type RawOriginal = Pick<
  RawCandidate,
  'id' | 'amount' | 'currency' | 'bill_date' | 'market_name' | 'created_by_name'
>;

@Injectable()
export class BillDuplicatesService {
  constructor(private readonly em: EntityManager) {}

  /** Live confirmed bills of the household that may be the same purchase as `probe`. */
  async findCandidates(
    householdId: string,
    probe: DuplicateProbe,
    opts: {
      excludeBillId?: string;
      dateToleranceDays?: number;
      limit?: number;
    } = {},
  ): Promise<PossibleDuplicateDto[]> {
    const dateToleranceDays = opts.dateToleranceDays ?? 0;
    const limit = opts.limit ?? 5;
    const params: unknown[] = [householdId];
    let exclude = '';
    if (opts.excludeBillId) {
      exclude = 'AND b.id <> ?';
      params.push(opts.excludeBillId);
    }
    // Same normalization as the ranking: trimmed, case-insensitive.
    const register = probe.fiscal_register_id ?? '';
    const receipt = probe.fiscal_receipt_number ?? '';
    params.push(
      register,
      receipt,
      register,
      receipt,
      probe.amount,
      probe.currency,
      probe.bill_date,
      dateToleranceDays,
      probe.bill_date,
      dateToleranceDays,
    );

    const raw = await this.fetchRaw(exclude, params);

    const rows: CandidateRow[] = raw.map((r) => ({
      ...r,
      amount: Number(r.amount),
    }));
    return rankCandidates(probe, rows, { dateToleranceDays, limit }).map(
      ({ row, match }) => ({
        id: row.id,
        bill_date: row.bill_date,
        total_amount: row.amount,
        currency: row.currency,
        market_name: row.market_name,
        created_by_name: row.created_by_name,
        match,
      }),
    );
  }

  /** The bill a duplicate was marked as a copy of, without a match rating. */
  async originalOf(
    householdId: string,
    duplicateOfId: string,
  ): Promise<PossibleDuplicateDto> {
    const [row] = await this.fetchOriginal(householdId, duplicateOfId);
    if (!row) {
      throw new NotFoundException(`Bill with ID ${duplicateOfId} not found`);
    }
    return {
      id: row.id,
      bill_date: row.bill_date,
      total_amount: Number(row.amount),
      currency: row.currency,
      market_name: row.market_name,
      created_by_name: row.created_by_name,
    };
  }

  /**
   * Marks a confirmed bill as a duplicate of another bill. Both rows are
   * locked in id order, which stops two opposite marks from deadlocking.
   * A confirm that links can still deadlock with a mark; Postgres aborts one.
   */
  async markDuplicate(
    id: string,
    householdId: string,
    duplicateOfId: string,
  ): Promise<void> {
    await this.em.transactional(async (em) => {
      const locked = await em.find(
        Bill,
        {
          id: { $in: [id, duplicateOfId] },
          household: { id: householdId },
          deleted_at: null,
        },
        { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' } },
      );
      const bill = locked.find((b) => b.id === id);
      if (!bill) throw new NotFoundException(`Bill with ID ${id} not found`);
      if (bill.status !== BillStatus.CONFIRMED) {
        throw new ConflictException(
          bill.status === BillStatus.DUPLICATE
            ? `Bill with ID ${id} is already a duplicate; unmark it first`
            : `Bill with ID ${id} is not confirmed`,
        );
      }
      await this.linkAsDuplicate(em, bill, duplicateOfId, householdId);
      await em.flush();
    });
  }

  async unmarkDuplicate(id: string, householdId: string): Promise<void> {
    await this.em.transactional(async (em) => {
      const bill = await em.findOne(
        Bill,
        { id, household: { id: householdId }, deleted_at: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!bill) throw new NotFoundException(`Bill with ID ${id} not found`);
      if (bill.status !== BillStatus.DUPLICATE) {
        throw new BadRequestException(`Bill with ID ${id} is not a duplicate`);
      }
      bill.status = BillStatus.CONFIRMED;
      bill.duplicate_of = null;
      await em.flush();
    });
  }

  /**
   * After an original is soft-deleted, the oldest live duplicate becomes the
   * confirmed original and every other duplicate (deleted ones included, so
   * no chain can form) points at it. Runs inside the caller's transaction.
   */
  async promoteAfterDelete(
    em: EntityManager,
    originalId: string,
  ): Promise<void> {
    const live = await em.find(
      Bill,
      { duplicate_of: originalId, deleted_at: null },
      {
        lockMode: LockMode.PESSIMISTIC_WRITE,
        orderBy: { created_at: 'asc', id: 'asc' },
      },
    );
    const [promoted] = live;
    if (!promoted) return;
    promoted.status = BillStatus.CONFIRMED;
    promoted.duplicate_of = null;
    await em.flush();
    await em.nativeUpdate(
      Bill,
      { duplicate_of: originalId },
      { duplicate_of: promoted.id },
    );
  }

  /**
   * Makes `bill` a duplicate of `duplicateOfId`, or of that bill's original
   * when it is a duplicate itself, so a duplicate never points at a
   * duplicate. Runs inside the caller's transaction; the caller flushes.
   */
  async linkAsDuplicate(
    em: EntityManager,
    bill: Bill,
    duplicateOfId: string,
    householdId: string,
  ): Promise<void> {
    // A bill without an id would turn the re-point below into an unscoped update.
    if (!bill.id) throw new Error('linkAsDuplicate needs a flushed bill');
    if (duplicateOfId === bill.id) {
      throw new BadRequestException('A bill cannot be a duplicate of itself');
    }
    const lock = (billId: string) =>
      em.findOne(
        Bill,
        { id: billId, household: { id: householdId }, deleted_at: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
    const target = await lock(duplicateOfId);
    if (!target) {
      throw new NotFoundException(`Bill with ID ${duplicateOfId} not found`);
    }
    let original: Bill = target;
    if (target.status === BillStatus.DUPLICATE && target.duplicate_of) {
      const resolved = await lock(target.duplicate_of.id);
      if (!resolved) {
        throw new NotFoundException(
          `Bill with ID ${target.duplicate_of.id} not found`,
        );
      }
      original = resolved;
    }
    // The cycle case: this bill is already a duplicate of the target.
    if (original.id === bill.id) {
      throw new BadRequestException(
        `Bill with ID ${duplicateOfId} is already a duplicate of this bill`,
      );
    }
    if (original.status !== BillStatus.CONFIRMED) {
      throw new BadRequestException(
        `Bill with ID ${original.id} is not confirmed, so it cannot be an original`,
      );
    }
    // Deleted bills included: restoring or reading them must not find a chain.
    await em.nativeUpdate(
      Bill,
      { duplicate_of: bill.id, household: { id: householdId } },
      { duplicate_of: original.id },
    );
    bill.status = BillStatus.DUPLICATE;
    bill.duplicate_of = original;
  }

  private fetchOriginal(
    householdId: string,
    id: string,
  ): Promise<RawOriginal[]> {
    return this.em.getConnection().execute(
      `SELECT b.id, b.amount::text AS amount, b.currency::text AS currency,
              b.bill_date::text AS bill_date,
              COALESCE(m.name, b.market_name_raw) AS market_name,
              u.first_name AS created_by_name
         FROM bills b
         LEFT JOIN markets m ON m.id = b.market_id
         LEFT JOIN users u ON u.id = b.created_by_user_id
        WHERE b.id = ? AND b.household_id = ?`,
      [id, householdId],
    );
  }

  probeOf(bill: Bill): DuplicateProbe {
    return {
      amount: Number(bill.amount),
      currency: bill.currency ?? null,
      bill_date: bill.bill_date,
      market_id: bill.market?.id ?? null,
      market_name: bill.market?.name ?? bill.market_name_raw ?? null,
      fiscal_register_id: bill.fiscal_register_id ?? null,
      fiscal_receipt_number: bill.fiscal_receipt_number ?? null,
      purchase_time: bill.purchase_time ?? null,
    };
  }

  private fetchRaw(
    exclude: string,
    params: unknown[],
  ): Promise<RawCandidate[]> {
    const conn = this.em.getConnection();
    return conn.execute(
      `SELECT b.id, b.amount::text AS amount, b.currency::text AS currency,
              b.bill_date::text AS bill_date, b.market_id,
              COALESCE(m.name, b.market_name_raw) AS market_name,
              b.fiscal_register_id, b.fiscal_receipt_number,
              to_char(b.purchase_time, 'HH24:MI') AS purchase_time,
              to_char(b.created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
              u.first_name AS created_by_name
         FROM bills b
         LEFT JOIN markets m ON m.id = b.market_id
         LEFT JOIN users u ON u.id = b.created_by_user_id
        WHERE b.household_id = ?
          AND b.status = 'confirmed'
          AND b.deleted_at IS NULL
          ${exclude}
          AND (
            (nullif(trim(?), '') IS NOT NULL
              AND nullif(trim(?), '') IS NOT NULL
              AND lower(trim(b.fiscal_register_id)) = lower(trim(?))
              AND lower(trim(b.fiscal_receipt_number)) = lower(trim(?)))
            OR (b.amount = ?
              AND b.currency::text IS NOT DISTINCT FROM ?::text
              AND b.bill_date BETWEEN ?::date - ?::int AND ?::date + ?::int)
          )`,
      params,
    );
  }
}
