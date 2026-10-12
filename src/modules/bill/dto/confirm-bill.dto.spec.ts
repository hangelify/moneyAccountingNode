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
});
