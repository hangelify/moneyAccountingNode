import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateBillDto } from './create-bill.dto';
import { ConfirmBillDto } from './confirm-bill.dto';

function items(n: number) {
  return Array.from({ length: n }, () => ({
    sub_category_id: randomUUID(),
    product_count: 1,
    amount: 1,
  }));
}

describe.each<[string, new () => object, object]>([
  [
    'CreateBillDto',
    CreateBillDto,
    { bill_date: '2026-05-19', total_amount: 1 },
  ],
  [
    'ConfirmBillDto',
    ConfirmBillDto,
    { bill_date: '2026-05-19', total_amount: 1 },
  ],
])('%s items', (_, Dto, base) => {
  async function itemErrors(n: number) {
    const errors = await validate(
      plainToInstance(Dto, { ...base, items: items(n) }),
    );
    return errors.filter((e) => e.property === 'items');
  }

  it('rejects an empty list', async () => {
    expect(await itemErrors(0)).not.toHaveLength(0);
  });

  it('accepts 1 and 200 items', async () => {
    expect(await itemErrors(1)).toHaveLength(0);
    expect(await itemErrors(200)).toHaveLength(0);
  });

  it('rejects more than 200 items', async () => {
    expect(await itemErrors(201)).not.toHaveLength(0);
  });
});
