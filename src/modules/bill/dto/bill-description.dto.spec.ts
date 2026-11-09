import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ConfirmBillDto } from './confirm-bill.dto';
import { CreateBillDto } from './create-bill.dto';
import { UpdateBillDto } from './update-bill.dto';
import { MAX_BILL_DESCRIPTION_LENGTH } from './create-bill.dto';

const items = [
  { sub_category_id: randomUUID(), product_count: 1, amount: 12.5 },
];
const bodies = {
  CreateBillDto: [
    CreateBillDto,
    { bill_date: '2026-05-19', total_amount: 12.5, items },
  ],
  ConfirmBillDto: [
    ConfirmBillDto,
    { bill_date: '2026-05-19', total_amount: 12.5, items },
  ],
  UpdateBillDto: [UpdateBillDto, {}],
} as const;

async function errorProps(cls: new () => object, body: object) {
  const errors = await validate(plainToInstance(cls, body));
  return errors.map((e) => e.property);
}

describe.each(Object.entries(bodies))('%s description', (_, [cls, body]) => {
  it(`accepts ${MAX_BILL_DESCRIPTION_LENGTH} characters`, async () => {
    const description = 'x'.repeat(MAX_BILL_DESCRIPTION_LENGTH);
    expect(await errorProps(cls, { ...body, description })).toEqual([]);
  });

  it('rejects a longer description', async () => {
    const description = 'x'.repeat(MAX_BILL_DESCRIPTION_LENGTH + 1);
    expect(await errorProps(cls, { ...body, description })).toContain(
      'description',
    );
  });
});

describe('UpdateBillDto market_id', () => {
  it('accepts null to unlink the market', async () => {
    expect(await errorProps(UpdateBillDto, { market_id: null })).toEqual([]);
  });

  it('accepts a UUID', async () => {
    expect(
      await errorProps(UpdateBillDto, { market_id: randomUUID() }),
    ).toEqual([]);
  });

  it('rejects a non-UUID string', async () => {
    expect(await errorProps(UpdateBillDto, { market_id: 'lidl' })).toContain(
      'market_id',
    );
  });
});
