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
import {
  DuplicateSuggestionsResponseDto,
  PossibleDuplicateDto,
  type DuplicatePairDto,
} from './dto/bill-duplicates.dto';

const MAX_SUGGESTIONS = 100;
const MATCH_ORDER = { fiscal: 0, strong: 1, weak: 2 } as const;

/** A bill (`b`) as a `CandidateRow`; the caller adds the WHERE. */
const CANDIDATE_SELECT = `SELECT b.id, b.amount::text AS amount, b.currency::text AS currency,
              b.bill_date::text AS bill_date, b.market_id,
              COALESCE(m.name, b.market_name_raw) AS market_name,
              b.fiscal_register_id, b.fiscal_receipt_number,
              to_char(b.purchase_time, 'HH24:MI') AS purchase_time,
              to_char(b.created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
              u.first_name AS created_by_name
         FROM bills b
         LEFT JOIN markets m ON m.id = b.market_id
         LEFT JOIN users u ON u.id = b.created_by_user_id`;

const toCandidateRow = (r: RawCandidate): CandidateRow => ({
  ...r,
  amount: Number(r.amount),
});

const toPossibleDuplicate = (row: CandidateRow): PossibleDuplicateDto => ({
  id: row.id,
  bill_date: row.bill_date,
  total_amount: row.amount,
  currency: row.currency,
  market_name: row.market_name,
  created_by_name: row.created_by_name,
});

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

    const rows = raw.map(toCandidateRow);
    return rankCandidates(probe, rows, { dateToleranceDays, limit }).map(
      ({ row, match }) => ({ ...toPossibleDuplicate(row), match }),
    );
  }

  /**
   * Pairs of live confirmed bills that look like the same purchase and were
   * not dismissed. SQL only prefilters (a superset of what the ranker
   * accepts); the ranker decides and rates each pair.
   */
  async suggestions(
    householdId: string,
    query: { date_from?: string; date_to?: string },
  ): Promise<DuplicateSuggestionsResponseDto> {
    if (query.date_from && query.date_to && query.date_from > query.date_to) {
      throw new BadRequestException('date_from must not be later than date_to');
    }
    const conn = this.em.getConnection();
    // The same range applies to both bills of a pair, so its params repeat.
    let range = '';
    const rangeParams: string[] = [];
    if (query.date_from) {
      range += ' AND {t}.bill_date >= ?';
      rangeParams.push(query.date_from);
    }
    if (query.date_to) {
      range += ' AND {t}.bill_date <= ?';
      rangeParams.push(query.date_to);
    }
    const rangeFor = (t: string) => range.split('{t}').join(t);
    const pairs = (await conn.execute(
      `SELECT a.id AS a_id, b.id AS b_id
         FROM bills a
         JOIN bills b ON b.id > a.id
          AND b.household_id = a.household_id
          AND b.status = 'confirmed' AND b.deleted_at IS NULL
         LEFT JOIN bill_duplicate_dismissals d
           ON d.bill_id = a.id AND d.other_bill_id = b.id
        WHERE a.household_id = ?
          AND a.status = 'confirmed' AND a.deleted_at IS NULL
          AND d.id IS NULL
          ${rangeFor('a')}
          ${rangeFor('b')}
          AND (
            (nullif(trim(a.fiscal_register_id), '') IS NOT NULL
              AND nullif(trim(a.fiscal_receipt_number), '') IS NOT NULL
              AND lower(trim(a.fiscal_register_id)) = lower(trim(b.fiscal_register_id))
              AND lower(trim(a.fiscal_receipt_number)) = lower(trim(b.fiscal_receipt_number)))
            OR (a.amount = b.amount
              AND a.currency::text IS NOT DISTINCT FROM b.currency::text
              AND a.bill_date = b.bill_date)
          )`,
      [householdId, ...rangeParams, ...rangeParams],
    )) as Array<{ a_id: string; b_id: string }>;
    if (pairs.length === 0) return { pairs: [] };

    const ids = [...new Set(pairs.flatMap((p) => [p.a_id, p.b_id]))];
    const raw = (await conn.execute(
      `${CANDIDATE_SELECT} WHERE b.id = ANY(?::uuid[])`,
      [`{${ids.join(',')}}`],
    )) as RawCandidate[];
    const byId = new Map(raw.map((r) => [r.id, toCandidateRow(r)]));

    const ranked: DuplicatePairDto[] = [];
    for (const { a_id, b_id } of pairs) {
      const a = byId.get(a_id);
      const b = byId.get(b_id);
      if (!a || !b) continue;
      const [hit] = rankCandidates(a, [b], { dateToleranceDays: 0, limit: 1 });
      if (!hit) continue;
      ranked.push({
        bill: toPossibleDuplicate(a),
        other: toPossibleDuplicate(b),
        match: hit.match,
      });
    }
    ranked.sort(
      (x, y) =>
        MATCH_ORDER[x.match] - MATCH_ORDER[y.match] ||
        newest(y).localeCompare(newest(x)) ||
        x.bill.id.localeCompare(y.bill.id) ||
        x.other.id.localeCompare(y.other.id),
    );
    return { pairs: ranked.slice(0, MAX_SUGGESTIONS) };
  }

  /** Keeps both bills: the pair stops being suggested. Idempotent. */
  async dismiss(
    id: string,
    householdId: string,
    userId: string,
    otherBillId: string,
  ): Promise<void> {
    if (otherBillId === id) {
      throw new BadRequestException(
        'A bill cannot be dismissed against itself',
      );
    }
    const conn = this.em.getConnection();
    const found = (await conn.execute(
      `SELECT id FROM bills
        WHERE id IN (?, ?) AND household_id = ? AND deleted_at IS NULL`,
      [id, otherBillId, householdId],
    )) as Array<{ id: string }>;
    for (const billId of [id, otherBillId]) {
      if (!found.some((r) => r.id === billId)) {
        throw new NotFoundException(`Bill with ID ${billId} not found`);
      }
    }
    await conn.execute(
      `INSERT INTO bill_duplicate_dismissals
              (household_id, bill_id, other_bill_id, dismissed_by_user_id)
       VALUES (?, least(?::uuid, ?::uuid), greatest(?::uuid, ?::uuid), ?)
       ON CONFLICT DO NOTHING`,
      [householdId, id, otherBillId, id, otherBillId, userId],
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
      `${CANDIDATE_SELECT}
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

/** The later bill_date of a pair (ISO days compare as strings). */
function newest(p: DuplicatePairDto): string {
  return p.bill.bill_date > p.other.bill_date
    ? p.bill.bill_date
    : p.other.bill_date;
}
