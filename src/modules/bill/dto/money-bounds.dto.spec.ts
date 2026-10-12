import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateBillDto } from './create-bill.dto';
import { ConfirmBillDto } from './confirm-bill.dto';
import { UpdateBillDto } from './update-bill.dto';
import { CreatePlaningHorizonDto } from '../../planing-horizon/dto/create-planing-horizon.dto';
import { UpdatePlaningHorizonDto } from '../../planing-horizon/dto/update-planing-horizon.dto';

const item = (over: object = {}) => ({
  sub_category_id: randomUUID(),
  product_count: 1,
  amount: 1,
  ...over,
});

const billBase = { bill_date: '2026-05-19', total_amount: 1, items: [item()] };
const horizonBase = {
  name: 'Q1',
  amount: 1,
  currency: 'EUR',
  period_type: 'monthly',
};

type Case = [string, new () => object, object, (v: number) => object, string];

const cases: Case[] = [
  [
    'CreateBillDto.total_amount',
    CreateBillDto,
    billBase,
    (v) => ({ total_amount: v }),
    'total_amount',
  ],
  [
    'CreateBillDto.items[].amount',
    CreateBillDto,
    billBase,
    (v) => ({ items: [item({ amount: v })] }),
    'items',
  ],
  [
    'ConfirmBillDto.total_amount',
    ConfirmBillDto,
    billBase,
    (v) => ({ total_amount: v }),
    'total_amount',
  ],
  [
    'ConfirmBillDto.items[].amount',
    ConfirmBillDto,
    billBase,
    (v) => ({ items: [item({ amount: v })] }),
    'items',
  ],
  [
    'UpdateBillDto.total_amount',
    UpdateBillDto,
    {},
    (v) => ({ total_amount: v }),
    'total_amount',
  ],
  [
    'CreatePlaningHorizonDto.amount',
    CreatePlaningHorizonDto,
    horizonBase,
    (v) => ({ amount: v }),
    'amount',
  ],
  [
    'UpdatePlaningHorizonDto.amount',
    UpdatePlaningHorizonDto,
    {},
    (v) => ({ amount: v }),
    'amount',
  ],
];

describe.each(cases)('%s', (_, Dto, base, patch, property) => {
  async function errorsFor(v: number) {
    const errors = await validate(
      plainToInstance(Dto, { ...base, ...patch(v) }),
    );
    return errors.filter((e) => e.property === property);
  }

  it('accepts an amount with two decimal places', async () => {
    expect(await errorsFor(12.34)).toHaveLength(0);
  });

  it('accepts the maximum amount', async () => {
    expect(await errorsFor(1e12)).toHaveLength(0);
  });

  it('rejects an amount with three decimal places', async () => {
    expect(await errorsFor(12.345)).not.toHaveLength(0);
  });

  it('rejects an amount that overflows the column', async () => {
    expect(await errorsFor(1e18)).not.toHaveLength(0);
  });

  it('rejects an exponent-notation fraction without throwing', async () => {
    expect(await errorsFor(1e-7)).not.toHaveLength(0);
  });
});

describe('CreateBillItemDto.product_weight', () => {
  async function errorsFor(v: number) {
    const errors = await validate(
      plainToInstance(CreateBillDto, {
        ...billBase,
        items: [item({ product_weight: v })],
      }),
    );
    return errors.filter((e) => e.property === 'items');
  }

  it('accepts a weight with three decimal places', async () => {
    expect(await errorsFor(1.234)).toHaveLength(0);
  });

  it('rejects a weight with four decimal places', async () => {
    expect(await errorsFor(1.2345)).not.toHaveLength(0);
  });

  it('rejects a weight that overflows decimal(10,3)', async () => {
    expect(await errorsFor(1e8)).not.toHaveLength(0);
  });

  it('rejects an exponent-notation weight without throwing', async () => {
    expect(await errorsFor(1e-7)).not.toHaveLength(0);
  });

  it('rejects a non-positive weight', async () => {
    expect(await errorsFor(0)).not.toHaveLength(0);
  });
});
