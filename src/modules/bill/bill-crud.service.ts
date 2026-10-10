import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager, LockMode } from '@mikro-orm/core';
import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { User } from '../../entities/user.entity';
import { Household } from '../../entities/household.entity';
import { BillStatus } from '../../types/bill-status.enum';
import { Currency } from '../../types/currency.enum';
import { ListBillsQueryDto } from './dto/list-bills-query.dto';
import { CreateBillDto, CreateBillItemDto } from './dto/create-bill.dto';
import { UpdateBillDto } from './dto/update-bill.dto';
import { ConfirmBillDto } from './dto/confirm-bill.dto';
import type {
  ParsedBillResponseDto,
  ParsedBillItemResponseDto,
} from './dto/parsed-bill-response.dto';
import {
  ITEM_UNITS,
  MAX_AMOUNT,
  MAX_ITEM_NAME_LENGTH,
  MAX_PRICE_PER_UNIT,
  MAX_QUANTITY,
  MAX_WEIGHT_KG,
} from './tasks/schemas/parsed-bill.schema';
import { BillResponseDto, BillMarketRefDto } from './dto/bill-response.dto';
import {
  BillDetailResponseDto,
  BillItemResponseDto,
} from './dto/bill-detail-response.dto';
import {
  BillListResponseDto,
  PaginationMetaDto,
} from './dto/bill-list-response.dto';

// A draft is saved from the AI output after the call is paid for, so values
// its columns cannot hold become empty instead of failing the INSERT.
const CURRENCIES = new Set<string>(Object.values(Currency));
const UNITS = new Set<string>(ITEM_UNITS);

function inRange(v: number | null | undefined, max: number) {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max
    ? v
    : undefined;
}

function toCurrency(v: string | null): Currency | undefined {
  const code = v?.trim().toUpperCase();
  return code && CURRENCIES.has(code) ? (code as Currency) : undefined;
}

/** A real `YYYY-MM-DD` date, or today. */
function toDraftDate(v: string | null): Date {
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= '0001-01-01') {
    const d = new Date(v);
    // Rejects roll-overs such as 2026-02-30 -> 2026-03-02.
    if (!Number.isNaN(d.getTime()) && d.toISOString().startsWith(v)) return d;
  }
  return new Date();
}

function toDraftItem(it: ParsedBillItemResponseDto) {
  const quantity = inRange(it.quantity, MAX_QUANTITY);
  const confidence = inRange(it.category_confidence, 1);
  return {
    ...it,
    name: it.name.slice(0, MAX_ITEM_NAME_LENGTH),
    quantity:
      quantity !== undefined && Number.isInteger(quantity) && quantity >= 0
        ? quantity
        : null,
    unit: it.unit && UNITS.has(it.unit) ? it.unit : null,
    weight_kg: inRange(it.weight_kg, MAX_WEIGHT_KG) ?? null,
    price_per_kg: inRange(it.price_per_kg, MAX_PRICE_PER_UNIT) ?? null,
    final_price: inRange(it.final_price, MAX_AMOUNT) ?? 0,
    category_confidence:
      confidence !== undefined && confidence >= 0 ? confidence : undefined,
  };
}

@Injectable()
export class BillCrudService {
  constructor(
    @InjectRepository(Bill)
    private readonly billRepository: EntityRepository<Bill>,
    @InjectRepository(Market)
    private readonly marketRepository: EntityRepository<Market>,
    @InjectRepository(SubCategory)
    private readonly subCategoryRepository: EntityRepository<SubCategory>,
    private readonly em: EntityManager,
  ) {}

  async createBill(
    householdId: string,
    userId: string,
    dto: CreateBillDto,
  ): Promise<BillDetailResponseDto> {
    let market: Market | null = null;
    if (dto.market_id) {
      market = await this.marketRepository.findOne({
        id: dto.market_id,
        household: { id: householdId },
        deleted_at: null,
      });
      if (!market) {
        throw new BadRequestException(
          `Market with ID ${dto.market_id} not found or belongs to another user`,
        );
      }
    }

    const bill = new Bill();
    bill.household = this.em.getReference(Household, householdId);
    bill.created_by = this.em.getReference(User, userId);
    bill.bill_date = new Date(dto.bill_date);
    bill.amount = dto.total_amount;
    bill.description = dto.description;
    bill.currency = dto.currency;
    if (market) bill.market = market;

    const subCats = await this.findSubCategories(householdId, dto.items);
    const bscEntities = this.toBillItems(bill, dto.items, subCats);

    this.em.persist(bill);
    for (const bsc of bscEntities) this.em.persist(bsc);
    await this.em.flush();
    return this.toDetailDto(bill, bscEntities);
  }

  async listBills(
    householdId: string,
    filters: ListBillsQueryDto,
  ): Promise<BillListResponseDto> {
    if (
      filters.date_from &&
      filters.date_to &&
      new Date(filters.date_from) > new Date(filters.date_to)
    ) {
      throw new BadRequestException('date_from must not be later than date_to');
    }

    const conditions: string[] = [
      `b.household_id = ?`,
      `b.status     = 'confirmed'`,
      `b.deleted_at IS NULL`,
    ];
    const params: unknown[] = [householdId];

    if (filters.date_from) {
      conditions.push(`b.bill_date >= ?`);
      params.push(filters.date_from);
    }
    if (filters.date_to) {
      conditions.push(`b.bill_date <= ?`);
      params.push(filters.date_to);
    }
    if (filters.market_names?.length) {
      conditions.push(`m.name = ANY(?)`);
      params.push(filters.market_names);
    }
    if (filters.currency) {
      conditions.push(`b.currency = ?`);
      params.push(filters.currency);
    }
    for (const bound of filters.amount_range ?? []) {
      const match = /^(gt|lt)_(\d+(?:\.\d+)?)$/.exec(bound);
      if (!match) continue;
      const [, op, val] = match;
      if (op === 'gt') {
        conditions.push(`b.amount > ?`);
      } else {
        conditions.push(`b.amount < ?`);
      }
      params.push(Number(val));
    }

    const where = conditions.join(' AND ');
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const offset = (page - 1) * limit;

    const [countRows, dataRows] = await Promise.all([
      this.em.getConnection().execute(
        `SELECT COUNT(*) AS count
         FROM   bills b
         LEFT   JOIN markets m ON m.id = b.market_id
         WHERE  ${where}`,
        params,
      ) as Promise<Array<{ count: string }>>,
      this.em.getConnection().execute(
        `SELECT b.id, b.bill_date::text, b.currency, b.amount::text, b.description,
                b.created_at::text,
                m.id AS market_id, m.name AS market_name, m.city AS market_city
         FROM   bills b
         LEFT   JOIN markets m ON m.id = b.market_id
         WHERE  ${where}
         ORDER  BY b.bill_date DESC
         LIMIT  ? OFFSET ?`,
        [...params, limit, offset],
      ) as Promise<
        Array<{
          id: string;
          bill_date: string;
          currency: string | null;
          amount: string;
          description: string | null;
          market_id: string | null;
          market_name: string | null;
          market_city: string | null;
          created_at: string;
        }>
      >,
    ]);

    const total = Number(countRows[0].count);
    const meta: PaginationMetaDto = {
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };

    const data = dataRows.map(
      (r): BillResponseDto => ({
        id: r.id,
        bill_date: new Date(r.bill_date),
        currency: (r.currency ?? undefined) as Currency | undefined,
        total_amount: Number(r.amount),
        description: r.description ?? undefined,
        market: r.market_id
          ? {
              id: r.market_id,
              name: r.market_name!,
              city: r.market_city ?? undefined,
            }
          : undefined,
        created_at: new Date(r.created_at),
      }),
    );

    return { data, meta };
  }

  async getBill(
    id: string,
    householdId: string,
  ): Promise<BillDetailResponseDto> {
    const bill = await this.billRepository.findOne(
      { id, household: { id: householdId }, deleted_at: null },
      { populate: ['market', 'billSubCategories.sub_category.category'] },
    );
    if (!bill) throw new NotFoundException(`Bill with ID ${id} not found`);
    return this.toDetailDto(bill, bill.billSubCategories.getItems());
  }

  async updateBill(
    id: string,
    householdId: string,
    dto: UpdateBillDto,
  ): Promise<BillResponseDto> {
    const bill = await this.billRepository.findOne(
      { id, household: { id: householdId }, deleted_at: null },
      { populate: ['market'] },
    );
    if (!bill) throw new NotFoundException(`Bill with ID ${id} not found`);

    if (dto.market_id !== undefined) {
      const market = await this.marketRepository.findOne({
        id: dto.market_id,
        household: { id: householdId },
        deleted_at: null,
      });
      if (!market) {
        throw new BadRequestException(
          `Market with ID ${dto.market_id} not found or belongs to another user`,
        );
      }
      bill.market = market;
    }
    if (dto.bill_date !== undefined) bill.bill_date = new Date(dto.bill_date);
    if (dto.currency !== undefined) bill.currency = dto.currency;
    if (dto.total_amount !== undefined) bill.amount = dto.total_amount;
    if (dto.description !== undefined) bill.description = dto.description;

    await this.em.persist(bill).flush();
    return this.toListDto(bill);
  }

  async softDeleteBill(id: string, householdId: string): Promise<void> {
    const bill = await this.billRepository.findOne({
      id,
      household: { id: householdId },
      deleted_at: null,
    });
    if (!bill) throw new NotFoundException(`Bill with ID ${id} not found`);
    bill.deleted_at = new Date();
    await this.em.persist(bill).flush();
  }

  async createDraftFromParsed(
    householdId: string,
    userId: string,
    dto: ParsedBillResponseDto,
  ): Promise<string> {
    const bill = new Bill();
    bill.household = this.em.getReference(Household, householdId);
    bill.created_by = this.em.getReference(User, userId);
    bill.status = BillStatus.DRAFT;
    bill.market_name_raw = dto.market_name ?? undefined;
    bill.bill_date = toDraftDate(dto.bill_date);
    bill.amount = inRange(dto.total_amount, MAX_AMOUNT) ?? 0;
    bill.currency = toCurrency(dto.currency);
    this.em.persist(bill);

    type Entry = {
      raw_name: string;
      amount: number;
      product_count: number;
      weight_kg?: number;
      unit?: string;
      price_per_unit?: number;
      category_confidence?: number;
      category_reasoning?: string;
      sub_category_id?: string;
    };

    const categorized = new Map<string, Entry>();
    const uncategorized: Entry[] = [];

    for (const raw of dto.items) {
      const item = toDraftItem(raw);
      if (item.sub_category) {
        const id = item.sub_category.id;
        const existing = categorized.get(id);
        if (existing) {
          existing.amount += item.final_price;
          existing.product_count += item.quantity ?? 1;
          existing.weight_kg ??= item.weight_kg ?? undefined;
          existing.unit ??= item.unit ?? undefined;
          existing.price_per_unit ??= item.price_per_kg ?? undefined;
          // category_confidence and category_reasoning: keep first item's values per spec
        } else {
          categorized.set(id, {
            raw_name: item.name,
            amount: item.final_price,
            product_count: item.quantity ?? 1,
            weight_kg: item.weight_kg ?? undefined,
            unit: item.unit ?? undefined,
            price_per_unit: item.price_per_kg ?? undefined, // DTO field is price_per_kg; entity is price_per_unit (unit varies: kg, l, piece)
            category_confidence: item.category_confidence,
            category_reasoning: item.category_reasoning ?? undefined,
            sub_category_id: id,
          });
        }
      } else {
        uncategorized.push({
          raw_name: item.name,
          amount: item.final_price,
          product_count: item.quantity ?? 1,
          weight_kg: item.weight_kg ?? undefined,
          unit: item.unit ?? undefined,
          price_per_unit: item.price_per_kg ?? undefined,
          category_confidence: item.category_confidence,
          category_reasoning: item.category_reasoning ?? undefined,
        });
      }
    }

    for (const entry of [...categorized.values(), ...uncategorized]) {
      const bsc = new BillSubCategory();
      bsc.bill = bill;
      bsc.raw_name = entry.raw_name;
      bsc.product_count = entry.product_count;
      bsc.amount = entry.amount;
      if (entry.weight_kg !== undefined) bsc.product_weight = entry.weight_kg;
      if (entry.unit !== undefined) bsc.unit = entry.unit;
      if (entry.price_per_unit !== undefined)
        bsc.price_per_unit = entry.price_per_unit;
      if (entry.category_confidence !== undefined)
        bsc.category_confidence = entry.category_confidence;
      if (entry.category_reasoning !== undefined)
        bsc.category_reasoning = entry.category_reasoning;
      if (entry.sub_category_id !== undefined) {
        bsc.sub_category = this.em.getReference(
          SubCategory,
          entry.sub_category_id,
        );
      }
      this.em.persist(bsc);
    }

    await this.em.flush();
    return bill.id;
  }

  async listDrafts(householdId: string): Promise<BillResponseDto[]> {
    const bills = await this.billRepository.find(
      {
        household: { id: householdId },
        status: BillStatus.DRAFT,
        deleted_at: null,
      },
      { populate: ['market'] },
    );
    return bills.map((b) => this.toListDto(b));
  }

  async confirmBill(
    id: string,
    householdId: string,
    userId: string,
    dto: ConfirmBillDto,
  ): Promise<BillDetailResponseDto> {
    // Validate before touching the draft: a rejected confirm keeps its items.
    const subCats = await this.findSubCategories(householdId, dto.items);

    return this.em.transactional(async (em) => {
      // Not filtered by status: a concurrent confirm waits on the row lock,
      // then sees CONFIRMED here and gets 409 instead of writing its items.
      const bill = await em.findOne(
        Bill,
        { id, household: { id: householdId }, deleted_at: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!bill)
        throw new NotFoundException(`Draft bill with ID ${id} not found`);
      if (bill.status !== BillStatus.DRAFT)
        throw new ConflictException(`Bill with ID ${id} is already confirmed`);

      bill.created_by = em.getReference(User, userId);

      // Resolve market
      if (dto.market_id) {
        const market = await em.findOne(Market, {
          id: dto.market_id,
          household: { id: householdId },
          deleted_at: null,
        });
        if (!market) {
          throw new BadRequestException(
            `Market with ID ${dto.market_id} not found or belongs to another user`,
          );
        }
        bill.market = market;
      } else if (dto.new_market) {
        bill.market = await this.findOrCreateMarket(
          em,
          householdId,
          dto.new_market,
        );
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        bill.market = null as any;
      }

      // Apply overrides
      if (dto.bill_date !== undefined) bill.bill_date = new Date(dto.bill_date);
      if (dto.currency !== undefined) bill.currency = dto.currency;
      if (dto.total_amount !== undefined) bill.amount = dto.total_amount;
      if (dto.description !== undefined) bill.description = dto.description;

      // Replace items
      await em.nativeDelete(BillSubCategory, { bill: id });
      const bscEntities = this.toBillItems(bill, dto.items, subCats);

      bill.status = BillStatus.CONFIRMED;
      for (const bsc of bscEntities) em.persist(bsc);
      await em.flush();

      return this.toDetailDto(bill, bscEntities);
    });
  }

  /**
   * Loads the household's sub-categories for `items` in one query.
   * Throws 400 on a repeated or unknown id.
   */
  private async findSubCategories(
    householdId: string,
    items: CreateBillItemDto[],
  ): Promise<Map<string, SubCategory>> {
    const ids = new Set<string>();
    for (const { sub_category_id } of items) {
      if (ids.has(sub_category_id)) {
        throw new BadRequestException(
          `Duplicate sub_category_id ${sub_category_id} in items: merge them into one item`,
        );
      }
      ids.add(sub_category_id);
    }

    const found = await this.subCategoryRepository.find(
      {
        id: { $in: [...ids] },
        deleted_at: null,
        category: { household: { id: householdId }, deleted_at: null },
      },
      { populate: ['category'] },
    );
    const byId = new Map(found.map((s) => [s.id, s]));
    const missing = [...ids].filter((sid) => !byId.has(sid));
    if (missing.length) {
      throw new BadRequestException(
        `SubCategory with ID ${missing.join(', ')} not found or belongs to another user`,
      );
    }
    return byId;
  }

  private toBillItems(
    bill: Bill,
    items: CreateBillItemDto[],
    subCats: Map<string, SubCategory>,
  ): BillSubCategory[] {
    return items.map((item) => {
      const subCat = subCats.get(item.sub_category_id)!;
      const bsc = new BillSubCategory();
      bsc.bill = bill;
      bsc.sub_category = subCat;
      bsc.raw_name = subCat.name;
      bsc.product_count = item.product_count;
      bsc.amount = item.amount;
      if (item.product_weight !== undefined)
        bsc.product_weight = item.product_weight;
      return bsc;
    });
  }

  private async findOrCreateMarket(
    em: EntityManager,
    householdId: string,
    dto: { name: string; city?: string; country?: string; address?: string },
  ): Promise<Market> {
    const existing = await em.findOne(Market, {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      name: { $ilike: dto.name } as any,
      household: { id: householdId },
      deleted_at: null,
    });
    if (existing) return existing;

    const market = new Market();
    market.name = dto.name;
    market.city = dto.city;
    market.country = dto.country;
    market.address = dto.address;
    market.household = em.getReference(Household, householdId);
    em.persist(market);
    return market;
  }

  private toMarketRef(market?: Market): BillMarketRefDto | undefined {
    if (!market) return undefined;
    return { id: market.id, name: market.name, city: market.city };
  }

  private toListDto(bill: Bill): BillResponseDto {
    return {
      id: bill.id,
      bill_date: bill.bill_date,
      currency: bill.currency,
      total_amount: bill.amount,
      description: bill.description,
      market: this.toMarketRef(bill.market),
      created_at: bill.created_at,
    };
  }

  private toDetailDto(
    bill: Bill,
    items: BillSubCategory[],
  ): BillDetailResponseDto {
    return {
      ...this.toListDto(bill),
      items: items.map(
        (bsc): BillItemResponseDto => ({
          sub_category: bsc.sub_category
            ? {
                id: bsc.sub_category.id,
                name: bsc.sub_category.name,
                category_name: bsc.sub_category.category?.name ?? '',
              }
            : null,
          product_count: bsc.product_count,
          amount: bsc.amount,
          product_weight: bsc.product_weight,
        }),
      ),
    };
  }
}
