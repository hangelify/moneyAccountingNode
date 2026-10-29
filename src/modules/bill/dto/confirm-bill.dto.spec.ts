import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ConfirmBillDto } from './confirm-bill.dto';

const valid = {
  bill_date: '2026-05-19',
  total_amount: 12.5,
  items: [{ sub_category_id: randomUUID(), product_count: 1, amount: 12.5 }],
};

async function errorProps(body: object) {
  const errors = await validate(plainToInstance(ConfirmBillDto, body));
  return errors.map((e) => e.property);
}

describe('ConfirmBillDto', () => {
  it('accepts a bill with a total, a date and items', async () => {
    expect(await errorProps(valid)).toEqual([]);
  });

  it('requires total_amount', async () => {
    const body: Partial<typeof valid> = { ...valid };
    delete body.total_amount;
    expect(await errorProps(body)).toContain('total_amount');
  });

  it.each([0, -5])('rejects total_amount %s', async (total_amount) => {
    expect(await errorProps({ ...valid, total_amount })).toContain(
      'total_amount',
    );
  });

  it('requires bill_date', async () => {
    const body: Partial<typeof valid> = { ...valid };
    delete body.bill_date;
    expect(await errorProps(body)).toContain('bill_date');
  });

  describe('items', () => {
    async function itemErrors(item: object) {
      const errors = await validate(
        plainToInstance(ConfirmBillDto, { ...valid, items: [item] }),
      );
      return errors.flatMap((e) =>
        (e.children ?? []).flatMap((c) =>
          (c.children ?? []).map((g) => g.property),
        ),
      );
    }

    it('accepts a draft line id, an edited raw_name and no sub-category', async () => {
      expect(
        await itemErrors({
          id: randomUUID(),
          raw_name: 'Milk 1L',
          product_count: 1,
          amount: 2,
        }),
      ).toEqual([]);
    });

    it('accepts a draft line id alone, keeping its raw_name', async () => {
      expect(
        await itemErrors({ id: randomUUID(), product_count: 1, amount: 2 }),
      ).toEqual([]);
    });

    it('requires raw_name on a new line without a sub-category', async () => {
      expect(await itemErrors({ product_count: 1, amount: 2 })).toContain(
        'raw_name',
      );
    });

    it.each([
      ['id', { id: 'nope' }],
      ['raw_name', { raw_name: '' }],
      ['raw_name', { raw_name: 'x'.repeat(256) }],
    ])('rejects a bad %s', async (prop, bad) => {
      expect(
        await itemErrors({
          sub_category_id: randomUUID(),
          product_count: 1,
          amount: 2,
          ...bad,
        }),
      ).toContain(prop);
    });
  });
});
