import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { Bill, BILLS_CLIENT_BATCH_UNIQUE } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { Category } from '../../entities/category.entity';
import { Household } from '../../entities/household.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { User } from '../../entities/user.entity';
import { BillSource } from '../../types/bill-source.enum';
import { BillStatus } from '../../types/bill-status.enum';
import { Currency } from '../../types/currency.enum';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { MarketService } from '../market/market.service';
import { assignLineCategory, toBillResponse } from './bill-lines';
import {
  BILL_ITEM_TOLERANCE,
  DEFAULT_BILL_ITEM_TOLERANCE,
} from './bill-totals';
import { BillConversionService } from './household-conversion';
import { BillListItemDto } from './dto/bill-response.dto';
import { ManualBatchDto, ManualBatchRowDto } from './dto/manual-batch.dto';
import {
  ManualBatchResponseDto,
  ManualBatchRowErrorDto,
} from './dto/manual-batch-response.dto';

/** What each row of a checked batch names, by id. */
interface RowRefs {
  categories: Map<string, Category>;
  subCats: Map<string, SubCategory>;
  markets: Map<string, Market>;
}

/**
 * Saves the manual quick-entry form: each row becomes a confirmed bill with
 * one line (HAN-48). The batch is all or nothing, and `client_batch_id`
 * makes a resent submit return the bills it saved instead of copies.
 */
@Injectable()
export class ManualBillBatchService {
  private readonly log = new Logger(ManualBillBatchService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly markets: MarketService,
    private readonly exchangeRates: ExchangeRateService,
    private readonly conversion: BillConversionService,
    @Optional()
    @Inject(BILL_ITEM_TOLERANCE)
    private readonly itemTolerance: number = DEFAULT_BILL_ITEM_TOLERANCE,
  ) {}

  /** `created` is false when the key was used before: nothing was saved. */
  async createBatch(
    householdId: string,
    userId: string,
    dto: ManualBatchDto,
  ): Promise<{ created: boolean; body: ManualBatchResponseDto }> {
    const saved = await this.replay(householdId, dto.client_batch_id);
    if (saved) return { created: false, body: saved };

    const refs = await this.checkRows(householdId, dto.rows);
    const household = await this.em.findOneOrFail(
      Household,
      { id: householdId },
      { fields: ['currency'] },
    );

    let bills: Bill[];
    try {
      bills = await this.em.transactional((em) =>
        this.write(em, householdId, userId, household.currency, dto, refs),
      );
    } catch (err) {
      // The same submit, sent twice at once: the other one saved it.
      if (
        err instanceof UniqueConstraintViolationException &&
        (err as { constraint?: string }).constraint ===
          BILLS_CLIENT_BATCH_UNIQUE
      ) {
        this.em.clear();
        const other = await this.replay(householdId, dto.client_batch_id);
        if (other) return { created: false, body: other };
      }
      throw err;
    }

    await this.warmRates(household.currency, bills);
    return {
      created: true,
      body: await this.toResponse(householdId, dto.client_batch_id, bills),
    };
  }

  /** The bills a used key saved, deleted ones included; null for a new key. */
  private async replay(
    householdId: string,
    key: string,
  ): Promise<ManualBatchResponseDto | null> {
    const bills = await this.em.find(
      Bill,
      { household: householdId, client_batch_id: key },
      {
        populate: ['market', 'billSubCategories'],
        orderBy: { client_batch_index: 'asc' },
      },
    );
    if (!bills.length) return null;
    return this.toResponse(householdId, key, bills);
  }

  /**
   * Loads what the rows name, live and in the household, and throws 400 with
   * every bad row when one names something else.
   */
  private async checkRows(
    householdId: string,
    rows: ManualBatchRowDto[],
  ): Promise<RowRefs> {
    const ids = (pick: (r: ManualBatchRowDto) => string | undefined) => [
      ...new Set(rows.map(pick).filter((v): v is string => !!v)),
    ];
    const categoryIds = ids((r) => r.category_id);
    const subCatIds = ids((r) => r.sub_category_id);
    const marketIds = ids((r) => r.market_id);

    const refs: RowRefs = {
      categories: new Map(
        (
          await this.em.find(Category, {
            id: { $in: categoryIds },
            household: householdId,
            deleted_at: null,
          })
        ).map((c) => [c.id, c]),
      ),
      subCats: new Map(
        (subCatIds.length
          ? await this.em.find(
              SubCategory,
              {
                id: { $in: subCatIds },
                deleted_at: null,
                category: { household: householdId, deleted_at: null },
              },
              { populate: ['category'] },
            )
          : []
        ).map((s) => [s.id, s]),
      ),
      markets: new Map(
        (marketIds.length
          ? await this.em.find(Market, {
              id: { $in: marketIds },
              household: householdId,
              deleted_at: null,
            })
          : []
        ).map((m) => [m.id, m]),
      ),
    };

    const errors: ManualBatchRowErrorDto[] = [];
    rows.forEach((row, index) => {
      const fail = (field: string, message: string) =>
        errors.push({ index, field, message });
      if (!refs.categories.has(row.category_id)) {
        fail('category_id', 'Category not found');
      }
      if (row.sub_category_id) {
        const subCat = refs.subCats.get(row.sub_category_id);
        if (!subCat) fail('sub_category_id', 'Sub-category not found');
        else if (subCat.category.id !== row.category_id) {
          fail('sub_category_id', 'Sub-category is not in this category');
        }
      }
      if (row.market_id && !refs.markets.has(row.market_id)) {
        fail('market_id', 'Market not found');
      }
    });
    if (errors.length) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Some rows are invalid',
        errors,
      });
    }
    return refs;
  }

  private async write(
    em: EntityManager,
    householdId: string,
    userId: string,
    householdCurrency: Currency,
    dto: ManualBatchDto,
    refs: RowRefs,
  ): Promise<Bill[]> {
    // One market per name, ignoring case; the first spelling names it.
    const byName = new Map<string, Market>();
    for (const { market_name: name } of dto.rows) {
      if (name && !byName.has(name.toLowerCase())) {
        byName.set(
          name.toLowerCase(),
          await this.markets.findOrCreate(em, householdId, { name }),
        );
      }
    }

    const bills = dto.rows.map((row, index) => {
      const bill = new Bill();
      bill.household = em.getReference(Household, householdId);
      bill.created_by = em.getReference(User, userId);
      bill.source = BillSource.MANUAL;
      bill.status = BillStatus.CONFIRMED;
      bill.bill_date = row.bill_date;
      bill.amount = row.amount;
      // A bill without a currency is left out of the household totals.
      bill.currency = row.currency ?? householdCurrency;
      bill.client_batch_id = dto.client_batch_id;
      bill.client_batch_index = index;
      const market = row.market_id
        ? refs.markets.get(row.market_id)
        : row.market_name
          ? byName.get(row.market_name.toLowerCase())
          : undefined;
      if (market) bill.market = market;

      const subCat = row.sub_category_id
        ? refs.subCats.get(row.sub_category_id)!
        : null;
      const category = refs.categories.get(row.category_id)!;
      const line = new BillSubCategory();
      line.bill = bill;
      assignLineCategory(line, subCat, category);
      line.raw_name = row.note ?? subCat?.name ?? category.name;
      line.product_count = 1;
      line.amount = row.amount;
      bill.billSubCategories.add(line);
      em.persist(bill);
      return bill;
    });
    await em.flush();
    return bills;
  }

  /**
   * Saves the rates of the batch's days once it has committed. Never throws:
   * the bills stand even if the rate API is down.
   */
  private async warmRates(
    householdCurrency: Currency,
    bills: Bill[],
  ): Promise<void> {
    const days = [
      ...new Set(
        bills
          .filter((b) => b.currency !== householdCurrency)
          .map((b) => b.bill_date),
      ),
    ];
    if (!days.length) return;
    try {
      await this.exchangeRates.ensureDays(days, { max: days.length });
    } catch (e) {
      this.log.warn(
        `Could not save rates for a manual batch: ${(e as Error).message}`,
      );
    }
  }

  private async toResponse(
    householdId: string,
    key: string,
    bills: Bill[],
  ): Promise<ManualBatchResponseDto> {
    const converted = await this.conversion.forBills(
      householdId,
      bills.map((b) => b.id),
    );
    return {
      client_batch_id: key,
      bills: bills.map((bill): BillListItemDto => {
        const conversion = converted.get(bill.id);
        return {
          ...toBillResponse(
            bill,
            bill.billSubCategories.getItems(),
            this.itemTolerance,
          ),
          status: bill.status,
          duplicate_of_id: bill.duplicate_of?.id ?? null,
          household_currency: conversion?.household_currency,
          household_amount: conversion?.household_amount ?? null,
        };
      }),
    };
  }
}
