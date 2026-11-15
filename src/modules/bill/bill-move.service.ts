import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { Bill } from '../../entities/bill.entity';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { Log, LogLevel, LogSource } from '../../entities/log.entity';
import { User } from '../../entities/user.entity';
import { Currency } from '../../types/currency.enum';
import { ExchangeRateService } from '../exchange-rate';
import { findHouseholdRole } from '../household';
import { MarketService } from '../market';
import { warmBillRates } from './bill-rates';
import {
  MoveBillsDto,
  MoveBillsResponseDto,
  MovedBillDto,
} from './dto/move-bills.dto';

/** A bill row locked for the move. */
interface LockedBill {
  id: string;
  household_id: string;
  status: string;
  image_sha256: string | null;
  client_batch_id: string | null;
  client_batch_index: number | null;
  market_id: string | null;
}

/** A live market of a moved bill, with the details to recreate it. */
interface SourceMarket {
  bill_id: string;
  name: string;
  city: string | null;
  country: string | null;
  address: string | null;
}

/** What one remapped line lost. */
interface RemappedLine {
  bill_id: string;
  lost_sub: boolean;
  lost_cat: boolean;
}

/** The moved bills and what the warming after the commit needs. */
interface MoveResult {
  body: MoveBillsResponseDto;
  currency: Currency;
  bills: Pick<Bill, 'currency' | 'bill_date'>[];
}

/**
 * Moves bills to another household of the user (HAN-23). Categories,
 * sub-categories and markets belong to a household, so the lines and the
 * market are remapped onto the target's ones by name. All or nothing.
 */
@Injectable()
export class BillMoveService {
  private readonly log = new Logger(BillMoveService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly markets: MarketService,
    private readonly exchangeRates: ExchangeRateService,
  ) {}

  async move(
    sourceHouseholdId: string,
    userId: string,
    dto: MoveBillsDto,
  ): Promise<MoveBillsResponseDto> {
    const result = await this.em.transactional((em) =>
      this.write(em, sourceHouseholdId, userId, dto),
    );
    await warmBillRates(
      { rates: this.exchangeRates, log: this.log },
      result.currency,
      result.bills,
      'a bill move',
    );
    return result.body;
  }

  private async write(
    em: EntityManager,
    sourceHouseholdId: string,
    userId: string,
    dto: MoveBillsDto,
  ): Promise<MoveResult> {
    const target = dto.target_household_id;
    const role = await findHouseholdRole(
      em.getRepository(Household),
      em.getRepository(HouseholdMember),
      target,
      userId,
    );
    if (!role) throw new ForbiddenException();
    if (target === sourceHouseholdId) {
      throw new BadRequestException('Target household is the source household');
    }

    const locked = await this.lockBills(em, sourceHouseholdId, target, dto);
    // Bills found in neither household are skipped for now (HAN-23 task 5).
    const ids = locked
      .filter((b) => b.household_id === sourceHouseholdId)
      .map((b) => b.id);
    const lines = await this.moveBills(em, target, ids);
    const moved = countLines(dto.bill_ids, ids, lines);

    em.create(Log, {
      level: LogLevel.INFO,
      source: LogSource.API,
      context: 'BillMove',
      message: `Moved ${String(ids.length)} bill(s) to household ${target}`,
      metadata: {
        source_household_id: sourceHouseholdId,
        target_household_id: target,
        bill_ids: dto.bill_ids,
        lost: moved.map((m) => ({
          id: m.id,
          sub: m.lines_lost_sub_category,
          cat: m.lines_lost_category,
        })),
      },
      user: em.getReference(User, userId),
      created_at: new Date(),
    });
    await em.flush();

    const household = await em.findOneOrFail(
      Household,
      { id: target },
      { fields: ['currency'] },
    );
    const bills = await em.find(
      Bill,
      { id: { $in: ids } },
      { fields: ['currency', 'bill_date'] },
    );
    return {
      body: { target_household_id: target, bills: moved },
      currency: household.currency,
      bills,
    };
  }

  /**
   * Moves the locked bills of the source: markets, lines, the bills, then
   * their dismissals. Returns what each remapped line lost.
   */
  private async moveBills(
    em: EntityManager,
    target: string,
    ids: string[],
  ): Promise<RemappedLine[]> {
    const marketOf = await this.targetMarkets(em, target, ids);
    const lines = await this.remapLines(em, target, ids);
    await this.exec(
      em,
      `UPDATE bills b
       SET    household_id = ?, market_id = v.market_id, updated_at = now()
       FROM   unnest(?::uuid[], ?::uuid[]) AS v(id, market_id)
       WHERE  b.id = v.id`,
      [target, uuids(ids), uuids(ids.map((id) => marketOf.get(id) ?? null))],
    );
    // Dismissals pair bills of one household; the moved ones' pairs no longer do.
    await this.exec(
      em,
      `DELETE FROM bill_duplicate_dismissals
       WHERE  bill_id = ANY(?::uuid[]) OR other_bill_id = ANY(?::uuid[])`,
      [uuids(ids), uuids(ids)],
    );
    return lines;
  }

  /** The live requested bills of both households, locked in id order. */
  private lockBills(
    em: EntityManager,
    sourceHouseholdId: string,
    target: string,
    dto: MoveBillsDto,
  ): Promise<LockedBill[]> {
    // id order, as markDuplicate locks, so concurrent moves cannot deadlock.
    return this.exec<LockedBill>(
      em,
      `SELECT id, household_id, status, image_sha256, client_batch_id, client_batch_index, market_id
       FROM   bills
       WHERE  id = ANY(?::uuid[]) AND household_id IN (?, ?) AND deleted_at IS NULL
       ORDER  BY id
       FOR    UPDATE`,
      [uuids(dto.bill_ids), sourceHouseholdId, target],
    );
  }

  /**
   * The target market of each moved bill whose market is live: the target's
   * market of that name, ignoring case, created with the same details when
   * missing. A bill without a live market gets none.
   */
  private async targetMarkets(
    em: EntityManager,
    target: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    const rows = await this.exec<SourceMarket>(
      em,
      `SELECT b.id AS bill_id, m.name, m.city, m.country, m.address
       FROM   bills b
       JOIN   markets m ON m.id = b.market_id AND m.deleted_at IS NULL
       WHERE  b.id = ANY(?::uuid[])`,
      [uuids(ids)],
    );
    const byName = new Map<string, SourceMarket>();
    for (const row of rows) byName.set(row.name.toLowerCase(), row);
    const targetIds = new Map<string, string>();
    // Inserting in name order keeps concurrent moves from deadlocking.
    for (const name of [...byName.keys()].sort((x, y) => x.localeCompare(y))) {
      const m = byName.get(name);
      if (!m) continue;
      const market = await this.markets.findOrCreate(em, target, {
        name: m.name,
        city: m.city ?? undefined,
        country: m.country ?? undefined,
        address: m.address ?? undefined,
      });
      targetIds.set(name, market.id);
    }
    return new Map(
      rows.flatMap((r) => {
        const id = targetIds.get(r.name.toLowerCase());
        return id ? [[r.bill_id, id] as const] : [];
      }),
    );
  }

  /**
   * Points the lines of the bills at the target's categories: the pair of
   * the same names, else the category of that name without a sub-category,
   * else none. Source names match even when deleted; target ones only live.
   * The self-join `prev` keeps the old ids visible to RETURNING.
   */
  private remapLines(
    em: EntityManager,
    target: string,
    ids: string[],
  ): Promise<RemappedLine[]> {
    const lost = `(prev.sub_category_id IS NOT NULL AND tsc.id IS NULL AND tc.id IS NOT NULL)
               OR (prev.category_id IS NOT NULL AND tc.id IS NULL)`;
    return this.exec<RemappedLine>(
      em,
      `UPDATE bill_sub_categories bsc
       SET    category_id         = tc.id,
              sub_category_id     = tsc.id,
              category_confidence = CASE WHEN ${lost} THEN NULL ELSE bsc.category_confidence END,
              category_reasoning  = CASE WHEN ${lost} THEN NULL ELSE bsc.category_reasoning END
       FROM   bill_sub_categories prev
       LEFT JOIN categories     sc  ON sc.id = prev.category_id
       LEFT JOIN sub_categories ssc ON ssc.id = prev.sub_category_id
       LEFT JOIN categories     tc  ON tc.household_id = ? AND tc.deleted_at IS NULL
                                   AND lower(tc.name) = lower(sc.name)
       LEFT JOIN sub_categories tsc ON tsc.category_id = tc.id AND tsc.deleted_at IS NULL
                                   AND lower(tsc.name) = lower(ssc.name)
       WHERE  bsc.id = prev.id AND prev.bill_id = ANY(?::uuid[])
       RETURNING bsc.bill_id,
                 (prev.sub_category_id IS NOT NULL AND tsc.id IS NULL AND tc.id IS NOT NULL) AS lost_sub,
                 (prev.category_id IS NOT NULL AND tc.id IS NULL) AS lost_cat`,
      [target, uuids(ids)],
    );
  }

  private async exec<T>(
    em: EntityManager,
    query: string,
    params: unknown[],
  ): Promise<T[]> {
    return (await em
      .getConnection()
      .execute(query, params, 'all', em.getTransactionContext())) as T[];
  }
}

/** One entry per moved bill, in the order of the request. */
function countLines(
  order: string[],
  ids: string[],
  lines: RemappedLine[],
): MovedBillDto[] {
  const counts = new Map<string, MovedBillDto>(
    ids.map((id) => [
      id,
      {
        id,
        lines_total: 0,
        lines_lost_sub_category: 0,
        lines_lost_category: 0,
        already_moved: false,
      },
    ]),
  );
  for (const line of lines) {
    const c = counts.get(line.bill_id);
    if (!c) continue;
    c.lines_total++;
    if (line.lost_sub) c.lines_lost_sub_category++;
    if (line.lost_cat) c.lines_lost_category++;
  }
  return order.flatMap((id) => counts.get(id) ?? []);
}

/**
 * A uuid[] literal: knex would expand a bound array into one placeholder
 * per value. The ids are uuids (validated or read back), so need no quoting.
 */
function uuids(ids: (string | null)[]): string {
  return `{${ids.map((id) => id ?? 'NULL').join(',')}}`;
}
