import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { BadRequestException } from '@nestjs/common';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { BillSource } from '../../types/bill-source.enum';
import { BillStatus } from '../../types/bill-status.enum';
import { ExchangeRateService } from '../exchange-rate';
import { StubProvider } from '../exchange-rate/testing';
import { MarketService } from '../market';
import { BillCrudService } from './bill-crud.service';
import { BillDuplicatesService } from './bill-duplicates.service';
import { BillConversionService } from './household-conversion';
import { UpdateBillDto } from './dto/update-bill.dto';
import { BillDetailResponseDto } from './dto/bill-detail-response.dto';
import { defined } from '../../common/testing/defined';

/** A decimal column as a number: MikroORM reads them back as strings. */
const money = (v: unknown): number => Number(v);

jest.setTimeout(30_000);

// Editing a manual bill through PUT keeps its total and its lines in step
// (HAN-49): the only line follows total_amount, and the shortcut fields
// category_id / sub_category_id / note edit that line without items.
describe('manual bill edit (PostgreSQL)', () => {
  let orm: MikroORM;
  const userId = randomUUID();
  const householdId = randomUUID();
  const food = randomUUID();
  const transport = randomUUID();
  const foodSub0 = randomUUID();
  const foodSub1 = randomUUID();
  const transportSub = randomUUID();

  const sql = (query: string, params: unknown[] = []): Promise<unknown> =>
    orm.em.getConnection().execute(query, params);

  beforeAll(async () => {
    orm = await MikroORM.init(createMikroOrmConfig());
    await sql(
      `insert into users (id, first_name, email, password) values (?, 'Manual edit', ?, 'x')`,
      [userId, `manual-edit-${userId}@example.com`],
    );
    await sql(
      `insert into households (id, name, created_by, currency) values (?, 'Manual edit', ?, 'EUR')`,
      [householdId, userId],
    );
    for (const [id, name] of [
      [food, 'Food'],
      [transport, 'Transport'],
    ]) {
      await sql(
        `insert into categories (id, name, household_id) values (?, ?, ?)`,
        [id, name, householdId],
      );
    }
    for (const [id, name, category] of [
      [foodSub0, 'Bread', food],
      [foodSub1, 'Milk', food],
      [transportSub, 'Taxi', transport],
    ]) {
      await sql(
        `insert into sub_categories (id, name, category_id) values (?, ?, ?)`,
        [id, name, category],
      );
    }
  });

  afterAll(async () => {
    await sql(
      `delete from bill_sub_categories where bill_id in (select id from bills where household_id = ?)`,
      [householdId],
    );
    await sql('delete from bills where household_id = ?', [householdId]);
    await sql(
      'delete from sub_categories where category_id in (select id from categories where household_id = ?)',
      [householdId],
    );
    await sql('delete from categories where household_id = ?', [householdId]);
    await sql('delete from households where id = ?', [householdId]);
    await sql('delete from users where id = ?', [userId]);
    await orm.close(true);
  });

  function crud(): BillCrudService {
    const fork = orm.em.fork();
    const rates = new ExchangeRateService(fork, new StubProvider());
    return new BillCrudService(
      fork.getRepository(Bill),
      fork.getRepository(Market),
      fork.getRepository(SubCategory),
      fork,
      rates,
      new BillConversionService(fork, rates),
      new BillDuplicatesService(fork),
      new MarketService(fork.getRepository(Market), fork),
    );
  }

  /**
   * A confirmed bill of amount 10 whose lines (Food › Bread, as the model
   * read it) have `amounts`; returns the bill id and its first line id.
   */
  async function makeBill(
    amounts: number[] = [10],
    source: BillSource = BillSource.MANUAL,
  ): Promise<{ id: string; lineId: string }> {
    const id = randomUUID();
    await sql(
      `insert into bills (id, household_id, bill_date, amount, status, currency, source)
       values (?, ?, '2026-11-10', 10, ?, 'EUR', ?)`,
      [id, householdId, BillStatus.CONFIRMED, source],
    );
    const lineIds = amounts.map(() => randomUUID());
    for (const [i, amount] of amounts.entries()) {
      await sql(
        `insert into bill_sub_categories
           (id, bill_id, raw_name, product_count, amount, price_per_unit,
            sub_category_id, category_id, category_confidence, category_reasoning)
         values (?, ?, 'Bread', 1, ?, ?, ?, ?, 0.9, 'Looks like bread.')`,
        [lineIds[i], id, amount, amount, foodSub0, food],
      );
    }
    return { id, lineId: defined(lineIds[0]) };
  }

  async function load(
    id: string,
  ): Promise<{ bill: Bill; lines: BillSubCategory[]; line: BillSubCategory }> {
    const fork = orm.em.fork();
    const bill = await fork.findOneOrFail(Bill, id);
    const lines = await fork.find(
      BillSubCategory,
      { bill: id },
      { orderBy: { amount: 'asc' } },
    );
    return { bill, lines, line: defined(lines[0]) };
  }

  const update = (
    id: string,
    dto: UpdateBillDto,
  ): Promise<BillDetailResponseDto> => crud().updateBill(id, householdId, dto);

  it('moves total_amount into the only line', async () => {
    const { id } = await makeBill();

    const result = await update(id, { total_amount: 7.5 });

    const { line } = await load(id);
    expect(money(line.amount)).toBe(7.5);
    expect(line.price_per_unit).toBeNull();
    expect(result.total_amount).toBe(7.5);
    expect(result.amount_mismatch).toBe(false);
  });

  it('moves the line to another category and drops a sub-category of the old one', async () => {
    const { id } = await makeBill();

    await update(id, { category_id: transport });

    const { line } = await load(id);
    expect(line.category?.id).toBe(transport);
    expect(line.sub_category).toBeNull();
    expect(line.category_confidence).toBeNull();
    expect(line.category_reasoning).toBeNull();
  });

  it('keeps the sub-category when category_id is the current one', async () => {
    const { id } = await makeBill();

    await update(id, { category_id: food });

    const { line } = await load(id);
    expect(line.sub_category?.id).toBe(foodSub0);
    expect(line.category?.id).toBe(food);
    expect(money(line.category_confidence)).toBeCloseTo(0.9);
  });

  it('sets the sub-category and its category from sub_category_id', async () => {
    const { id } = await makeBill();

    const result = await update(id, { sub_category_id: transportSub });

    const { line } = await load(id);
    expect(line.sub_category?.id).toBe(transportSub);
    expect(line.category?.id).toBe(transport);
    expect(result.items[0]?.category?.id).toBe(transport);
  });

  it('drops only the sub-category on sub_category_id null', async () => {
    const { id } = await makeBill();

    await update(id, { sub_category_id: null });

    const { line } = await load(id);
    expect(line.sub_category).toBeNull();
    expect(line.category?.id).toBe(food);
  });

  it('rejects a sub-category outside category_id', async () => {
    const { id } = await makeBill();

    await expect(
      update(id, { category_id: transport, sub_category_id: foodSub1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await load(id)).line.category?.id).toBe(food);
  });

  it('writes note into raw_name', async () => {
    const { id } = await makeBill();

    await update(id, { note: 'coffee' });

    expect((await load(id)).line.raw_name).toBe('coffee');
  });

  it('rejects shortcut fields together with items', async () => {
    const { id, lineId } = await makeBill();

    await expect(
      update(id, {
        note: 'coffee',
        items: [
          { id: lineId, category_id: food, product_count: 1, amount: 10 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((await load(id)).line.raw_name).toBe('Bread');
  });

  it('rejects shortcut fields on a photo bill', async () => {
    const { id } = await makeBill([10], BillSource.PHOTO);

    await expect(update(id, { category_id: transport })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect((await load(id)).line.category?.id).toBe(food);
  });

  it('rejects shortcut fields on a manual bill with two lines', async () => {
    const { id } = await makeBill([4, 6]);

    await expect(update(id, { note: 'coffee' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect((await load(id)).lines.map((l) => l.raw_name)).toEqual([
      'Bread',
      'Bread',
    ]);
  });

  it('adds a line through items and recomputes the total', async () => {
    const { id, lineId } = await makeBill();

    const result = await update(id, {
      items: [
        { id: lineId, category_id: food, product_count: 1, amount: 10 },
        { category_id: transport, product_count: 1, amount: 2.5 },
      ],
    });

    const { bill, lines } = await load(id);
    expect(lines).toHaveLength(2);
    expect(money(bill.amount)).toBe(12.5);
    expect(bill.source).toBe(BillSource.MANUAL);
    expect(result.amount_mismatch).toBe(false);
  });

  it('rejects items that do not add up to total_amount', async () => {
    const { id, lineId } = await makeBill();

    await expect(
      update(id, {
        total_amount: 20,
        items: [
          { id: lineId, category_id: food, product_count: 1, amount: 10 },
          { category_id: transport, product_count: 1, amount: 2.5 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const { bill, lines } = await load(id);
    expect(money(bill.amount)).toBe(10);
    expect(lines).toHaveLength(1);
  });

  it('rejects a total that no longer matches two lines', async () => {
    const { id } = await makeBill([4, 6]);

    await expect(update(id, { total_amount: 11 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(money((await load(id)).bill.amount)).toBe(10);
  });

  it('keeps the total of a mismatched manual bill when items only recategorise', async () => {
    const { id } = await makeBill([4, 4]);
    const { lines } = await load(id);

    const result = await update(id, {
      items: lines.map((l) => ({
        id: l.id,
        category_id: transport,
        product_count: 1,
        amount: money(l.amount),
      })),
    });

    expect(result.total_amount).toBe(10);
    expect(money((await load(id)).bill.amount)).toBe(10);
  });

  it('edits the date of a legacy manual bill with mismatched lines', async () => {
    const { id } = await makeBill([4, 4]);

    const result = await update(id, { bill_date: '2026-06-01' });

    expect(result.bill_date).toBe('2026-06-01');
    expect(result.amount_mismatch).toBe(true);
  });

  it('keeps a photo bill free to mismatch its items', async () => {
    const { id, lineId } = await makeBill([10], BillSource.PHOTO);

    const result = await update(id, {
      total_amount: 20,
      items: [{ id: lineId, category_id: food, product_count: 1, amount: 10 }],
    });

    expect(result.total_amount).toBe(20);
    expect(result.amount_mismatch).toBe(true);
  });
});
