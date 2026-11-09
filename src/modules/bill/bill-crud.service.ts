import {
  Inject,
  Injectable,
  Logger,
  Optional,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import {
  EntityRepository,
  EntityManager,
  LockMode,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { Market } from '../../entities/market.entity';
import { MarketService } from '../market/market.service';
import { SubCategory } from '../../entities/sub-category.entity';
import { Category } from '../../entities/category.entity';
import { User } from '../../entities/user.entity';
import { Household } from '../../entities/household.entity';
import { AiRequest } from '../../entities/ai-request.entity';
import { isCalendarDate, todayIsoDate } from '../../common/utils/calendar-date';
import { BillStatus } from '../../types/bill-status.enum';
import { BillSource } from '../../types/bill-source.enum';
import { BillParseErrorCode } from '../../types/bill-parse-error.enum';
import { Currency } from '../../types/currency.enum';
import { ListBillsQueryDto } from './dto/list-bills-query.dto';
import { CreateBillDto, CreateBillItemDto } from './dto/create-bill.dto';
import { UpdateBillDto } from './dto/update-bill.dto';
import {
  ConfirmBillDto,
  ConfirmBillItemDto,
  NewMarketDto,
} from './dto/confirm-bill.dto';
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
import {
  BillResponseDto,
  BillListItemDto,
  BillMarketRefDto,
} from './dto/bill-response.dto';
import {
  BILL_ITEM_TOLERANCE,
  DEFAULT_BILL_ITEM_TOLERANCE,
  isAmountMismatch,
} from './bill-totals';
import {
  BillDetailResponseDto,
  BillItemResponseDto,
  DraftListResponseDto,
} from './dto/bill-detail-response.dto';
import { ListDraftsQueryDto } from './dto/list-drafts-query.dto';
import { PossibleDuplicateDto } from './dto/bill-duplicates.dto';
import { BillDuplicatesService } from './bill-duplicates.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import {
  BillConversionService,
  householdConversionJoin,
} from './household-conversion';
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

/** A real `YYYY-MM-DD` date, or today (UTC) flagged as inferred. */
function toDraftDate(v: string | null): { date: string; inferred: boolean } {
  return isCalendarDate(v)
    ? { date: v, inferred: false }
    : { date: todayIsoDate(), inferred: true };
}

function numberOrNull(v: number | string | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** Where an AI draft came from: the stored receipt image and its AI request. */
export interface DraftSource {
  imageSha256: string;
  aiRequestId: string;
  /** Storage key of the receipt image. */
  imageKey?: string;
}

/** The household's sub-categories and categories the items of a write name. */
interface LineCategories {
  subCats: Map<string, SubCategory>;
  categories: Map<string, Category>;
}

/** The sub-category and the category an item names, from `found`. */
function lineCategoryOf(
  item: { sub_category_id?: string | null; category_id?: string },
  found: LineCategories,
): { subCat: SubCategory | null; category: Category | null } {
  return {
    subCat: item.sub_category_id
      ? found.subCats.get(item.sub_category_id)!
      : null,
    category: item.category_id ? found.categories.get(item.category_id)! : null,
  };
}

/**
 * Sets the line's sub-category and, with it, the line's category: the
 * column must stay the sub-category's category. Without a sub-category the
 * line takes `category`, or none. `subCat` needs its category loaded.
 */
function assignLineCategory(
  bsc: BillSubCategory,
  subCat: SubCategory | null,
  category: Category | null = null,
): void {
  bsc.sub_category = subCat;
  bsc.category = subCat?.category ?? category;
}

/** The line's own category, as answered; `category` needs its name loaded. */
function toCategoryRef(category: Category | null | undefined) {
  return category ? { id: category.id, name: category.name } : null;
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
  private readonly log = new Logger(BillCrudService.name);

  constructor(
    @InjectRepository(Bill)
    private readonly billRepository: EntityRepository<Bill>,
    @InjectRepository(Market)
    private readonly marketRepository: EntityRepository<Market>,
    @InjectRepository(SubCategory)
    private readonly subCategoryRepository: EntityRepository<SubCategory>,
    private readonly em: EntityManager,
    private readonly exchangeRates: ExchangeRateService,
    private readonly conversion: BillConversionService,
    private readonly duplicates: BillDuplicatesService,
    private readonly markets: MarketService,
    @Optional()
    @Inject(BILL_ITEM_TOLERANCE)
    private readonly itemTolerance: number = DEFAULT_BILL_ITEM_TOLERANCE,
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
    bill.source = BillSource.MANUAL;
    bill.bill_date = dto.bill_date;
    bill.amount = dto.total_amount;
    bill.description = dto.description;
    bill.currency = dto.currency;
    bill.fiscal_register_id = dto.fiscal_register_id;
    bill.fiscal_receipt_number = dto.fiscal_receipt_number;
    bill.purchase_time = dto.purchase_time;
    if (market) bill.market = market;

    const found = await this.findLineCategories(householdId, dto.items);
    const bscEntities = this.toBillItems(bill, dto.items, found);

    await this.em.transactional(async (em) => {
      em.persist(bill);
      for (const bsc of bscEntities) em.persist(bsc);
      if (dto.duplicate_of_id) {
        // The id is generated by the database: link only once it is set.
        await em.flush();
        await this.duplicates.linkAsDuplicate(
          em,
          bill,
          dto.duplicate_of_id,
          householdId,
        );
      }
      await em.flush();
    });
    await this.warmRate(householdId, bill);
    return {
      ...this.toDetailDto(bill, bscEntities),
      ...(await this.conversion.forBills(householdId, [bill.id])).get(bill.id),
      ...(await this.duplicateInfo(householdId, bill)),
    };
  }

  async listBills(
    householdId: string,
    filters: ListBillsQueryDto,
  ): Promise<BillListResponseDto> {
    if (
      filters.date_from &&
      filters.date_to &&
      filters.date_from > filters.date_to
    ) {
      throw new BadRequestException('date_from must not be later than date_to');
    }

    const conditions: string[] = [
      `b.household_id = ?`,
      filters.include_duplicates
        ? `b.status IN ('confirmed', 'duplicate')`
        : `b.status     = 'confirmed'`,
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
    const source = this.exchangeRates.source;

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
                b.status, b.source, b.duplicate_of_id, b.created_at::text,
                m.id AS market_id, m.name AS market_name, m.city AS market_city,
                abs(b.amount - i.total) > ? * i.count AS amount_mismatch,
                h.currency AS household_currency,
                ROUND(b.amount * fx.factor, 2)::text AS household_amount
         FROM   bills b
         ${householdConversionJoin('b')}
         -- A deleted market still shows on its bills, as history.
         LEFT   JOIN markets m ON m.id = b.market_id
         CROSS  JOIN LATERAL (
                  SELECT coalesce(sum(amount), 0) AS total, count(*) AS count
                  FROM   bill_sub_categories
                  WHERE  bill_id = b.id
                ) i
         WHERE  ${where}
         ORDER  BY b.bill_date DESC, b.created_at DESC, b.id DESC
         LIMIT  ? OFFSET ?`,
        [this.itemTolerance, source, source, ...params, limit, offset],
      ) as Promise<
        Array<{
          id: string;
          bill_date: string;
          currency: string | null;
          amount: string;
          description: string | null;
          status: BillStatus;
          source: BillSource;
          duplicate_of_id: string | null;
          market_id: string | null;
          market_name: string | null;
          market_city: string | null;
          created_at: string;
          amount_mismatch: boolean;
          household_currency: Currency;
          household_amount: string | null;
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
      (r): BillListItemDto => ({
        id: r.id,
        bill_date: r.bill_date,
        currency: (r.currency ?? undefined) as Currency | undefined,
        total_amount: Number(r.amount),
        amount_mismatch: r.amount_mismatch,
        description: r.description ?? undefined,
        status: r.status,
        source: r.source,
        duplicate_of_id: r.duplicate_of_id,
        market: r.market_id
          ? {
              id: r.market_id,
              name: r.market_name!,
              city: r.market_city ?? undefined,
            }
          : undefined,
        created_at: new Date(r.created_at),
        household_currency: r.household_currency,
        household_amount: numberOrNull(r.household_amount),
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
      {
        populate: [
          'market',
          'billSubCategories.sub_category.category',
          'billSubCategories.category',
        ],
      },
    );
    if (!bill) throw new NotFoundException(`Bill with ID ${id} not found`);
    const conversion = await this.conversion.forBills(householdId, [id]);
    return {
      ...this.toDetailDto(bill, bill.billSubCategories.getItems()),
      ...conversion.get(id),
      ...(await this.duplicateInfo(householdId, bill)),
    };
  }

  async updateBill(
    id: string,
    householdId: string,
    dto: UpdateBillDto,
  ): Promise<BillDetailResponseDto> {
    if (dto.market_id !== undefined && dto.new_market !== undefined) {
      throw new BadRequestException(
        'Send either market_id or new_market, not both',
      );
    }
    // Validate before touching the bill: a rejected update keeps its items.
    if (dto.items) this.checkLineIds(dto.items);
    const found = dto.items
      ? await this.findLineCategories(householdId, dto.items)
      : undefined;

    const updated = await this.em.transactional(async (em) => {
      const bill = await em.findOne(
        Bill,
        { id, household: { id: householdId }, deleted_at: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!bill) throw new NotFoundException(`Bill with ID ${id} not found`);
      // Not joined above: FOR UPDATE cannot lock the nullable side of a join.
      await em.populate(bill, ['market']);

      if (dto.market_id === null) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        bill.market = null as any;
      } else {
        const market = await this.resolveMarket(em, householdId, dto);
        if (market) bill.market = market;
      }
      if (dto.bill_date !== undefined) {
        bill.bill_date = dto.bill_date;
        bill.bill_date_inferred = false;
      }
      if (dto.currency !== undefined) bill.currency = dto.currency;
      if (dto.total_amount !== undefined) bill.amount = dto.total_amount;
      if (dto.description !== undefined) bill.description = dto.description;
      if (dto.fiscal_register_id !== undefined)
        bill.fiscal_register_id = dto.fiscal_register_id;
      if (dto.fiscal_receipt_number !== undefined)
        bill.fiscal_receipt_number = dto.fiscal_receipt_number;
      if (dto.purchase_time !== undefined)
        bill.purchase_time = dto.purchase_time;

      const lines = dto.items
        ? await this.applyItems(em, bill, dto.items, found!)
        : await em.find(BillSubCategory, { bill: bill.id });
      await em.flush();
      await em.populate(lines, ['sub_category.category', 'category']);
      return { bill, dto: this.toDetailDto(bill, lines) };
    });
    await this.warmRate(householdId, updated.bill);
    return {
      ...updated.dto,
      ...(await this.conversion.forBills(householdId, [id])).get(id),
      ...(await this.duplicateInfo(householdId, updated.bill)),
    };
  }

  async softDeleteBill(id: string, householdId: string): Promise<void> {
    await this.em.transactional(async (em) => {
      const bill = await em.findOne(
        Bill,
        { id, household: { id: householdId }, deleted_at: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!bill) throw new NotFoundException(`Bill with ID ${id} not found`);
      bill.deleted_at = new Date();
      await em.flush();
      // A confirmed bill may be the original of others; keep the purchase counted.
      if (bill.status === BillStatus.CONFIRMED) {
        await this.duplicates.promoteAfterDelete(em, bill.id);
      }
    });
  }

  async createDraftFromParsed(
    householdId: string,
    userId: string,
    dto: ParsedBillResponseDto,
    source?: DraftSource,
  ): Promise<{ id: string; duplicate: boolean }> {
    const bill = new Bill();
    bill.household = this.em.getReference(Household, householdId);
    bill.created_by = this.em.getReference(User, userId);
    bill.status = BillStatus.DRAFT;
    bill.source = BillSource.PHOTO;
    bill.market_name_raw = dto.market_name ?? undefined;
    const billDate = toDraftDate(dto.bill_date);
    bill.bill_date = billDate.date;
    bill.bill_date_inferred = billDate.inferred;
    if (source) {
      bill.image_sha256 = source.imageSha256;
      if (source.imageKey) bill.image_key = source.imageKey;
      bill.ai_request = this.em.getReference(AiRequest, source.aiRequestId);
    }
    bill.amount = inRange(dto.total_amount, MAX_AMOUNT) ?? 0;
    bill.currency = toCurrency(dto.currency);
    bill.fiscal_register_id = dto.fiscal_register_id ?? undefined;
    bill.fiscal_receipt_number = dto.fiscal_receipt_number ?? undefined;
    bill.purchase_time = dto.purchase_time ?? undefined;
    this.em.persist(bill);

    const subCats = await this.findDraftSubCategories(householdId, dto.items);
    // One row per receipt line, even when lines share a sub-category.
    for (const raw of dto.items) {
      const item = toDraftItem(raw);
      const bsc = new BillSubCategory();
      bsc.bill = bill;
      bsc.raw_name = item.name;
      bsc.product_count = item.quantity ?? 1;
      bsc.amount = item.final_price;
      if (item.weight_kg != null) bsc.product_weight = item.weight_kg;
      if (item.unit != null) bsc.unit = item.unit;
      // DTO field is price_per_kg; entity is price_per_unit (unit varies: kg, l, piece)
      if (item.price_per_kg != null) bsc.price_per_unit = item.price_per_kg;
      bsc.category_confidence = item.category_confidence;
      if (item.category_reasoning != null)
        bsc.category_reasoning = item.category_reasoning;
      assignLineCategory(
        bsc,
        (item.sub_category && subCats.get(item.sub_category.id)) || null,
      );
      this.em.persist(bsc);
    }

    try {
      await this.em.flush();
    } catch (err) {
      // The same image was uploaded concurrently and its draft won the
      // unique index: answer with that draft.
      if (source && err instanceof UniqueConstraintViolationException) {
        this.em.clear();
        const existing = await this.billRepository.findOne(
          this.openDraftOfImage(householdId, source.imageSha256),
          { fields: ['id'] },
        );
        if (existing) return { id: existing.id, duplicate: true };
      }
      throw err;
    }
    return { id: bill.id, duplicate: false };
  }

  /**
   * A photo that could not become a draft, kept with its error so the user
   * can see it and fill the bill in by hand. Persists on the caller's `em`
   * without flushing, so the caller owns the transaction.
   */
  createFailedBill(
    em: EntityManager,
    args: {
      householdId: string;
      userId: string | null;
      imageKey: string;
      imageSha256: string;
      code: BillParseErrorCode;
      message: string;
      aiRequestId?: string | null;
    },
  ): Bill {
    const bill = new Bill();
    bill.household = em.getReference(Household, args.householdId);
    if (args.userId) bill.created_by = em.getReference(User, args.userId);
    bill.status = BillStatus.FAILED;
    bill.source = BillSource.PHOTO;
    bill.amount = 0;
    bill.bill_date = todayIsoDate();
    bill.bill_date_inferred = true;
    bill.image_key = args.imageKey;
    bill.image_sha256 = args.imageSha256;
    bill.parse_error_code = args.code;
    bill.parse_error_message = args.message;
    if (args.aiRequestId) {
      bill.ai_request = em.getReference(AiRequest, args.aiRequestId);
    }
    em.persist(bill);
    return bill;
  }

  /** The open draft saved from this image, shaped like a fresh parse. */
  async findDraftByImageHash(
    householdId: string,
    imageSha256: string,
  ): Promise<{
    parsed: ParsedBillResponseDto;
    requestId: string | null;
  } | null> {
    const bill = await this.billRepository.findOne(
      this.openDraftOfImage(householdId, imageSha256),
      {
        populate: [
          'billSubCategories.sub_category.category',
          'billSubCategories.category',
        ],
      },
    );
    if (!bill) return null;
    return {
      requestId: bill.ai_request?.id ?? null,
      parsed: {
        draft_id: bill.id,
        market_name: bill.market_name_raw ?? null,
        bill_date: bill.bill_date_inferred ? null : bill.bill_date,
        currency: bill.currency ?? null,
        total_amount: Number(bill.amount),
        fiscal_register_id: bill.fiscal_register_id ?? null,
        fiscal_receipt_number: bill.fiscal_receipt_number ?? null,
        purchase_time: bill.purchase_time ?? null,
        items: bill.billSubCategories.getItems().map(
          (bsc): ParsedBillItemResponseDto => ({
            id: bsc.id,
            name: bsc.raw_name,
            // A weight-priced line is saved with a count of 1.
            quantity: bsc.product_weight == null ? bsc.product_count : null,
            unit: (bsc.unit ?? null) as ParsedBillItemResponseDto['unit'],
            weight_kg: numberOrNull(bsc.product_weight),
            price_per_kg: numberOrNull(bsc.price_per_unit),
            final_price: Number(bsc.amount),
            sub_category: bsc.sub_category
              ? {
                  id: bsc.sub_category.id,
                  name: bsc.sub_category.name,
                  category_name: bsc.sub_category.category?.name ?? '',
                }
              : null,
            category: toCategoryRef(bsc.category),
            category_confidence: Number(bsc.category_confidence ?? 0),
            category_reasoning: bsc.category_reasoning ?? undefined,
          }),
        ),
      },
    };
  }

  /** S3 key of the receipt photo a draft or failed bill of this household came from. */
  async getDraftImageKey(id: string, householdId: string): Promise<string> {
    const bill = await this.billRepository.findOne(
      {
        id,
        household: { id: householdId },
        status: { $in: [BillStatus.DRAFT, BillStatus.FAILED] },
        deleted_at: null,
      },
      { populate: ['ai_request'] },
    );
    const key = bill?.image_key ?? bill?.ai_request?.image_s3_keys?.[0];
    if (!key) {
      throw new NotFoundException(`No image for draft bill with ID ${id}`);
    }
    return key;
  }

  private openDraftOfImage(householdId: string, imageSha256: string) {
    return {
      household: { id: householdId },
      image_sha256: imageSha256,
      status: BillStatus.DRAFT,
      deleted_at: null,
    };
  }

  async listDrafts(
    householdId: string,
    query: ListDraftsQueryDto,
  ): Promise<DraftListResponseDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [bills, total] = await this.billRepository.findAndCount(
      {
        household: { id: householdId },
        status:
          query.status === 'failed' ? BillStatus.FAILED : BillStatus.DRAFT,
        deleted_at: null,
      },
      {
        populate: [
          'market',
          'billSubCategories.sub_category.category',
          'billSubCategories.category',
        ],
        orderBy: { created_at: 'desc', id: 'desc' },
        limit,
        offset: (page - 1) * limit,
      },
    );
    return {
      data: bills.map((b) =>
        this.toDetailDto(b, b.billSubCategories.getItems()),
      ),
      meta: { total, page, limit, total_pages: Math.ceil(total / limit) },
    };
  }

  async confirmBill(
    id: string,
    householdId: string,
    userId: string,
    dto: ConfirmBillDto,
  ): Promise<BillDetailResponseDto> {
    // Validate before touching the draft: a rejected confirm keeps its items.
    this.checkLineIds(dto.items);
    const found = await this.findLineCategories(householdId, dto.items);

    const confirmed = await this.em.transactional(async (em) => {
      // Not filtered by status: a concurrent confirm waits on the row lock,
      // then sees CONFIRMED here and gets 409 instead of writing its items.
      const bill = await em.findOne(
        Bill,
        { id, household: { id: householdId }, deleted_at: null },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!bill)
        throw new NotFoundException(`Draft bill with ID ${id} not found`);
      if (bill.status !== BillStatus.DRAFT && bill.status !== BillStatus.FAILED)
        throw new ConflictException(`Bill with ID ${id} is not a draft`);
      // The check constraint ties the error to the failed status, so both
      // go in the same flush as the status change.
      bill.parse_error_code = null;
      bill.parse_error_message = null;

      bill.confirmed_by = em.getReference(User, userId);
      bill.confirmed_at = new Date();

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      bill.market =
        (await this.resolveMarket(em, householdId, dto)) ?? (null as any);

      // Apply overrides
      bill.bill_date = dto.bill_date;
      bill.bill_date_inferred = false;
      bill.amount = dto.total_amount;
      if (dto.currency !== undefined) bill.currency = dto.currency;
      if (dto.description !== undefined) bill.description = dto.description;
      if (dto.fiscal_register_id !== undefined)
        bill.fiscal_register_id = dto.fiscal_register_id;
      if (dto.fiscal_receipt_number !== undefined)
        bill.fiscal_receipt_number = dto.fiscal_receipt_number;
      if (dto.purchase_time !== undefined)
        bill.purchase_time = dto.purchase_time;

      const bscEntities = await this.applyItems(em, bill, dto.items, found);

      if (dto.duplicate_of_id) {
        await this.duplicates.linkAsDuplicate(
          em,
          bill,
          dto.duplicate_of_id,
          householdId,
        );
      } else {
        bill.status = BillStatus.CONFIRMED;
      }
      await em.flush();

      return { bill, dto: this.toDetailDto(bill, bscEntities) };
    });
    await this.warmRate(householdId, confirmed.bill);
    return {
      ...confirmed.dto,
      ...(await this.conversion.forBills(householdId, [id])).get(id),
      ...(await this.duplicateInfo(householdId, confirmed.bill)),
    };
  }

  /**
   * Candidates for a bill that is already saved, or its original when it was
   * marked as a duplicate. Runs after the write has committed.
   */
  private async duplicateInfo(
    householdId: string,
    bill: Bill,
  ): Promise<
    Pick<BillDetailResponseDto, 'possible_duplicates' | 'duplicate_of'>
  > {
    if (bill.status === BillStatus.DUPLICATE && bill.duplicate_of) {
      return {
        possible_duplicates: [],
        duplicate_of: await this.duplicates.originalOf(
          householdId,
          bill.duplicate_of.id,
        ),
      };
    }
    return {
      possible_duplicates: await this.candidatesOf(householdId, bill),
      duplicate_of: null,
    };
  }

  /**
   * Never throws: the write stands even if the look-alike lookup fails. A
   * draft whose date was inferred has no reliable date, so only its receipt
   * ids can match. A failed bill always has an inferred date, so the same
   * applies to it.
   */
  private async candidatesOf(
    householdId: string,
    bill: Bill,
  ): Promise<PossibleDuplicateDto[]> {
    try {
      return await this.duplicates.findCandidates(
        householdId,
        this.duplicates.probeOf(bill),
        {
          excludeBillId: bill.id,
          fiscalOnly:
            (bill.status === BillStatus.DRAFT ||
              bill.status === BillStatus.FAILED) &&
            bill.bill_date_inferred,
        },
      );
    } catch (err) {
      this.log.error(
        `Looking up possible duplicates of bill ${bill.id} failed`,
        err instanceof Error ? err.stack : String(err),
      );
      return [];
    }
  }

  /**
   * Saves the bill's day of rates once the write has committed, so reads
   * never wait on the provider. A bill in the household's currency or without
   * one needs no rate. Never throws: the write stands even if the rate API is
   * down.
   */
  private async warmRate(householdId: string, bill: Bill): Promise<void> {
    if (!bill.currency) return;
    // The write has committed: failing here would invite a duplicate retry.
    try {
      const household = await this.em.findOne(
        Household,
        { id: householdId },
        { fields: ['currency'] },
      );
      if (!household || household.currency === bill.currency) return;
      await this.exchangeRates.ensureDays([bill.bill_date], { max: 1 });
    } catch (e) {
      this.log.warn(
        `Could not save rates for bill ${bill.id}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Loads the household's sub-categories for `items` in one query.
   * Throws 400 on an unknown id.
   */
  private async findSubCategories(
    householdId: string,
    items: { sub_category_id?: string | null }[],
  ): Promise<Map<string, SubCategory>> {
    const ids = new Set<string>();
    for (const { sub_category_id } of items) {
      if (sub_category_id) ids.add(sub_category_id);
    }
    if (!ids.size) return new Map();

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

  /**
   * The household's live categories named by `category_id`, by id. Throws
   * 400 on an unknown id.
   */
  private async findCategories(
    householdId: string,
    items: { category_id?: string }[],
  ): Promise<Map<string, Category>> {
    const ids = new Set<string>();
    for (const { category_id } of items) {
      if (category_id) ids.add(category_id);
    }
    if (!ids.size) return new Map();

    const found = await this.em.find(Category, {
      id: { $in: [...ids] },
      household: { id: householdId },
      deleted_at: null,
    });
    const byId = new Map(found.map((c) => [c.id, c]));
    const missing = [...ids].filter((cid) => !byId.has(cid));
    if (missing.length) {
      throw new BadRequestException(
        `Category with ID ${missing.join(', ')} not found or belongs to another user`,
      );
    }
    return byId;
  }

  /**
   * The sub-categories and categories the items name. Throws 400 on an
   * unknown id, or on an item whose sub-category is not of its category.
   */
  private async findLineCategories(
    householdId: string,
    items: { sub_category_id?: string | null; category_id?: string }[],
  ): Promise<LineCategories> {
    const found: LineCategories = {
      subCats: await this.findSubCategories(householdId, items),
      categories: await this.findCategories(householdId, items),
    };
    for (const item of items) {
      const { subCat, category } = lineCategoryOf(item, found);
      if (subCat && category && subCat.category.id !== category.id) {
        throw new BadRequestException(
          `SubCategory with ID ${subCat.id} is not in Category with ID ${category.id}`,
        );
      }
    }
    return found;
  }

  /**
   * The household's sub-categories the model picked for a draft, with their
   * categories, in one query. Soft-deleted ones count: one may be deleted
   * between the parse and the save. An id the household does not own is
   * left out, and its line is saved without a sub-category.
   */
  private async findDraftSubCategories(
    householdId: string,
    items: ParsedBillItemResponseDto[],
  ): Promise<Map<string, SubCategory>> {
    const ids = new Set<string>();
    for (const { sub_category } of items) {
      if (sub_category) ids.add(sub_category.id);
    }
    if (!ids.size) return new Map();

    const found = await this.subCategoryRepository.find(
      { id: { $in: [...ids] }, category: { household: { id: householdId } } },
      { populate: ['category'] },
    );
    return new Map(found.map((s) => [s.id, s]));
  }

  /** Throws 400 when two items name the same bill line. */
  private checkLineIds(items: { id?: string }[]): void {
    const lineIds = new Set<string>();
    for (const { id: lineId } of items) {
      if (!lineId) continue;
      if (lineIds.has(lineId)) {
        throw new BadRequestException(`Duplicate item id ${lineId} in items`);
      }
      lineIds.add(lineId);
    }
  }

  /**
   * The market named by `market_id` (400 when it is not the household's) or
   * found or created from `new_market`; undefined when neither is given.
   */
  private async resolveMarket(
    em: EntityManager,
    householdId: string,
    dto: { market_id?: string | null; new_market?: NewMarketDto },
  ): Promise<Market | undefined> {
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
      return market;
    }
    if (dto.new_market) {
      return this.markets.findOrCreate(em, householdId, dto.new_market);
    }
    return undefined;
  }

  /**
   * Updates the bill lines named by id in place, adds the lines without
   * one and removes the rest. A kept line keeps what the model read (name,
   * unit, confidence) unless the user changed it.
   */
  private async applyItems(
    em: EntityManager,
    bill: Bill,
    items: ConfirmBillItemDto[],
    found: LineCategories,
  ): Promise<BillSubCategory[]> {
    const drafted = new Map(
      (await em.find(BillSubCategory, { bill: bill.id })).map((l) => [l.id, l]),
    );
    const lines = items.map((item) => {
      const { subCat, category } = lineCategoryOf(item, found);
      let bsc: BillSubCategory;
      if (item.id) {
        const draftLine = drafted.get(item.id);
        if (!draftLine) {
          throw new BadRequestException(
            `Item with ID ${item.id} is not a line of this bill`,
          );
        }
        drafted.delete(item.id);
        bsc = draftLine;
        // The model's confidence and reasoning were about its sub-category,
        // or, on a line without one, its category.
        if (
          (bsc.sub_category?.id ?? null) !== (subCat?.id ?? null) ||
          (!subCat && (bsc.category?.id ?? null) !== (category?.id ?? null))
        ) {
          bsc.category_confidence = null;
          bsc.category_reasoning = null;
        }
        // The unit price was read off the receipt for the old amount and
        // weight (or count, on a line sold by the piece).
        const weight = item.product_weight ?? null;
        if (
          Number(bsc.amount) !== item.amount ||
          numberOrNull(bsc.product_weight) !== weight ||
          (weight === null && bsc.product_count !== item.product_count)
        ) {
          bsc.price_per_unit = null;
        }
      } else {
        bsc = new BillSubCategory();
        bsc.bill = bill;
        em.persist(bsc);
      }
      assignLineCategory(bsc, subCat, category);
      // The DTO requires raw_name on a new line with neither.
      bsc.raw_name =
        item.raw_name ?? bsc.raw_name ?? subCat?.name ?? category!.name;
      bsc.product_count = item.product_count;
      bsc.amount = item.amount;
      bsc.product_weight = item.product_weight ?? null;
      return bsc;
    });
    for (const left of drafted.values()) em.remove(left);
    return lines;
  }

  private toBillItems(
    bill: Bill,
    items: CreateBillItemDto[],
    found: LineCategories,
  ): BillSubCategory[] {
    return items.map((item) => {
      // The DTO requires a sub-category, a category or both.
      const { subCat, category } = lineCategoryOf(item, found);
      const bsc = new BillSubCategory();
      bsc.bill = bill;
      assignLineCategory(bsc, subCat, category);
      bsc.raw_name = subCat?.name ?? category!.name;
      bsc.product_count = item.product_count;
      bsc.amount = item.amount;
      if (item.product_weight !== undefined)
        bsc.product_weight = item.product_weight;
      return bsc;
    });
  }

  private toMarketRef(market?: Market): BillMarketRefDto | undefined {
    if (!market) return undefined;
    return { id: market.id, name: market.name, city: market.city };
  }

  private toListDto(bill: Bill, items: BillSubCategory[]): BillResponseDto {
    return {
      id: bill.id,
      bill_date: bill.bill_date,
      currency: bill.currency,
      total_amount: Number(bill.amount),
      amount_mismatch: isAmountMismatch(
        bill.amount,
        items.map((i) => i.amount),
        this.itemTolerance,
      ),
      description: bill.description,
      source: bill.source,
      market: this.toMarketRef(bill.market),
      created_at: bill.created_at,
    };
  }

  private toDetailDto(
    bill: Bill,
    items: BillSubCategory[],
  ): BillDetailResponseDto {
    return {
      ...this.toListDto(bill, items),
      status: bill.status,
      parse_error_code: bill.parse_error_code ?? null,
      parse_error_message: bill.parse_error_message ?? null,
      market_name_raw: bill.market_name_raw ?? undefined,
      bill_date_inferred: bill.bill_date_inferred,
      fiscal_register_id: bill.fiscal_register_id ?? null,
      fiscal_receipt_number: bill.fiscal_receipt_number ?? null,
      purchase_time: bill.purchase_time ?? null,
      items: items.map(
        (bsc): BillItemResponseDto => ({
          id: bsc.id,
          raw_name: bsc.raw_name,
          unit: bsc.unit ?? undefined,
          price_per_unit: numberOrNull(bsc.price_per_unit) ?? undefined,
          category_confidence:
            numberOrNull(bsc.category_confidence) ?? undefined,
          category_reasoning: bsc.category_reasoning ?? undefined,
          sub_category: bsc.sub_category
            ? {
                id: bsc.sub_category.id,
                name: bsc.sub_category.name,
                category_name: bsc.sub_category.category?.name ?? '',
              }
            : null,
          category: toCategoryRef(bsc.category),
          product_count: bsc.product_count,
          // decimal columns are read back as strings.
          amount: Number(bsc.amount),
          product_weight: numberOrNull(bsc.product_weight) ?? undefined,
        }),
      ),
    };
  }
}
