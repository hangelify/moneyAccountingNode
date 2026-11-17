import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { Currency } from '../../types/currency.enum';
import { LimitPeriodType } from '../../types/limit-period-type.enum';
import { todayIsoDate } from '../../common/utils/calendar-date';
import {
  limitPeriodEnd,
  limitPeriodStart,
} from '../../common/utils/period-range';
import { ExchangeRateService } from '../exchange-rate';
import { fetchUnconverted, loadRateDays, UnconvertedDto } from '../bill';
import {
  buildLimitReport,
  ChainPeriod,
  chainPeriods,
  ReportCategoryInfo,
  SpentRow,
} from './limit-report';
import {
  BaseLimitKey,
  convertBaseLimits,
  fetchSpent,
  readLimits,
  VersionRow,
} from './limit-report.queries';
import {
  assertLimitAt,
  CarryStopKey,
  deleteCarryStop,
  insertCarryStop,
} from './carry-stops';
import type {
  LimitReportCategoryDto,
  LimitReportDto,
} from './dto/limit-report.dto';
import type { SetCarryOverDto } from './dto/carry-over.dto';

/** What the report reads once the rates are loaded. */
interface Facts {
  converted: Map<string, string | null>;
  spent: SpentRow[];
  unconverted: UnconvertedDto[];
}

/** Spending against category limits of one period, with carry-over. */
@Injectable()
export class LimitReportService {
  constructor(
    private readonly em: EntityManager,
    private readonly exchangeRates: ExchangeRateService,
  ) {}

  async report(
    householdId: string,
    type: LimitPeriodType,
    date?: string,
    now: Date = new Date(),
  ): Promise<LimitReportDto> {
    const today = todayIsoDate(now);
    const day = date ?? today;
    const start = limitPeriodStart(type, day);
    const end = limitPeriodEnd(type, day);

    const limits = await this.em
      .fork()
      .transactional((tx) =>
        readLimits(tx, { householdId, type }, { start, end }),
      );

    const chains = chainPeriods(type, start, limits.versions, limits.stops);
    const chainStart = [...chains.values()].reduce(
      (min, chain) =>
        chain[0] && chain[0].period_start < min ? chain[0].period_start : min,
      start,
    );

    // Rates first, so the queries below see the days just saved.
    const currency = await loadRateDays(
      this.em.getConnection(),
      this.exchangeRates,
      householdId,
      chainStart,
      end,
    );
    const foreign = foreignBaseLimits(chains, currency, today);
    if (foreign.length > 0) {
      await this.exchangeRates.ensureDays(
        foreign.map((k) => k.day),
        { max: 10 },
      );
    }

    const { converted, spent, unconverted } = await this.readFacts(
      { householdId, type },
      { start, end, chainStart },
      foreign,
    );

    return buildLimitReport({
      type,
      start,
      end,
      currency,
      chains,
      categories: categoryInfo(limits.versions),
      baseLimits: baseLimits(chains, currency, converted),
      spent,
      stops: limits.stops,
      limitedCategoryIds: limits.limitedCategoryIds,
      unconverted,
    });
  }

  /**
   * Marks (`carry_over: false`) or unmarks the period "do not carry over";
   * both idempotent. Returns the category's row of the next period, where
   * the limit changes, or of the marked period when the next one has no
   * limit of the type.
   */
  // eslint-disable-next-line max-params -- сигнатура задана планом HAN-25; `now` подменяют тесты
  async setCarryOver(
    householdId: string,
    userId: string,
    categoryId: string,
    dto: SetCarryOverDto,
    now: Date = new Date(),
  ): Promise<LimitReportCategoryDto> {
    const type = dto.period_type;
    const periodStart = dto.period_start;
    if (periodStart !== limitPeriodStart(type, periodStart)) {
      throw new BadRequestException(
        `period_start ${periodStart} is not the start of a ${type} period`,
      );
    }
    if (periodStart > todayIsoDate(now)) {
      throw new BadRequestException(
        `period_start ${periodStart} is a future period`,
      );
    }

    const key: CarryStopKey = {
      householdId,
      categoryId,
      periodType: type,
      periodStart,
    };
    await this.em.fork().transactional(async (tx) => {
      await assertLimitAt(tx, key);
      if (dto.carry_over) {
        await deleteCarryStop(tx, key);
      } else {
        await insertCarryStop(tx, key, userId);
      }
    });

    for (const day of [limitPeriodEnd(type, periodStart), periodStart]) {
      const found = (
        await this.report(householdId, type, day, now)
      ).categories.find((c) => c.category_id === categoryId);
      if (found) return found;
    }
    // The version checked above puts the category in its period's report.
    throw new InternalServerErrorException(
      `Category ${categoryId} is not in the report of ${periodStart}`,
    );
  }

  /**
   * In one read transaction: foreign base limits converted, spending of the
   * whole chain range, and the unconverted bills of the report period.
   */
  private readFacts(
    scope: { householdId: string; type: LimitPeriodType },
    range: { start: string; end: string; chainStart: string },
    foreign: BaseLimitKey[],
  ): Promise<Facts> {
    const { householdId, type } = scope;
    const source = this.exchangeRates.source;
    return this.em.fork().transactional(async (tx) => {
      // A long chain hashes many (category, sub-category, period) groups.
      await tx
        .getConnection()
        .execute(
          `SET LOCAL work_mem = '16MB'`,
          [],
          'run',
          tx.getTransactionContext(),
        );
      const converted = await convertBaseLimits(
        tx,
        { source, householdId },
        foreign,
      );
      const spent = await fetchSpent(
        tx,
        { source, householdId, type },
        { start: range.chainStart, end: range.end },
      );
      const unconverted = await fetchUnconverted(
        tx.getConnection(),
        source,
        householdId,
        range.start,
        range.end,
        undefined,
        tx.getTransactionContext(),
      );
      return { converted, spent, unconverted };
    });
  }
}

const baseKey = (p: ChainPeriod): string => `${p.version.id}|${p.period_start}`;

/** Chain periods whose version is not in the household currency. */
function foreignBaseLimits(
  chains: Map<string, ChainPeriod[]>,
  currency: Currency,
  today: string,
): BaseLimitKey[] {
  return [...chains.values()].flat().flatMap((p) =>
    p.version.currency === currency
      ? []
      : [
          {
            key: baseKey(p),
            amount: p.version.amount,
            currency: p.version.currency,
            // A future period converts at today's rate.
            day: p.period_start < today ? p.period_start : today,
          },
        ],
  );
}

/** Base limits in household currency; null when no rate is saved. */
function baseLimits(
  chains: Map<string, ChainPeriod[]>,
  currency: Currency,
  converted: Map<string, string | null>,
): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const p of [...chains.values()].flat()) {
    const key = baseKey(p);
    result.set(
      key,
      p.version.currency === currency
        ? p.version.amount
        : (converted.get(key) ?? null),
    );
  }
  return result;
}

function categoryInfo(versions: VersionRow[]): Map<string, ReportCategoryInfo> {
  return new Map(
    versions.map((v) => [
      v.category_id,
      { category_id: v.category_id, name: v.name, archived: v.archived },
    ]),
  );
}
