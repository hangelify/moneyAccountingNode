import { randomUUID } from 'node:crypto';
import { ValidationError, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateBillDto } from './create-bill.dto';
import { ConfirmBillDto } from './confirm-bill.dto';
import { UpdateBillDto } from './update-bill.dto';
import {
  CreateCategoryLimitDto,
  UpdateCategoryLimitDto,
} from '../../category-limit';

const item = (over: object = {}) => ({
  sub_category_id: randomUUID(),
  product_count: 1,
  amount: 1,
  ...over,
});

const billBase = { bill_date: '2026-05-19', total_amount: 1, items: [item()] };
const limitBase = { period_type: 'MONTHLY', amount: 1 };

type Case = [string, new () => object, object, (v: number) => object, string];

// Limit amounts are strictly positive; their sign cases are below.
const limitCases: Case[] = [
  [
    'CreateCategoryLimitDto.amount',
    CreateCategoryLimitDto,
    { ...limitBase, category_id: randomUUID() },
    (v) => ({ amount: v }),
    'amount',
  ],
  [
    'UpdateCategoryLimitDto.amount',
    UpdateCategoryLimitDto,
    limitBase,
    (v) => ({ amount: v }),
    'amount',
  ],
];

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
  ...limitCases,
];

/** The validation errors of `property` when the case's amount is `v`. */
async function caseErrors(c: Case, v: number): Promise<ValidationError[]> {
  const [, Dto, base, patch, property] = c;
  const errors = await validate(plainToInstance(Dto, { ...base, ...patch(v) }));
  return errors.filter((e) => e.property === property);
}

describe.each(cases)('%s', (...c: Case) => {
  const errorsFor = (v: number): Promise<ValidationError[]> => caseErrors(c, v);

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

describe.each([
  ['CreateBillDto', CreateBillDto, billBase],
  ['ConfirmBillDto', ConfirmBillDto, billBase],
  ['UpdateBillDto', UpdateBillDto, {}],
] as [string, new () => object, object][])(
  '%s.items[].amount sign',
  (_, Dto, base) => {
    async function errorsFor(v: number) {
      const errors = await validate(
        plainToInstance(Dto, { ...base, items: [item({ amount: v })] }),
      );
      return errors.filter((e) => e.property === 'items');
    }

    it('accepts a negative amount (sales or discount line)', async () => {
      expect(await errorsFor(-3.5)).toHaveLength(0);
    });

    it('accepts the minimum amount', async () => {
      expect(await errorsFor(-1e12)).toHaveLength(0);
    });

    it('rejects a negative amount that overflows the column', async () => {
      expect(await errorsFor(-1e18)).not.toHaveLength(0);
    });

    it('rejects a zero amount', async () => {
      expect(await errorsFor(0)).not.toHaveLength(0);
    });
  },
);

// Limit amounts are strictly positive, unlike bill item amounts above.
describe.each(limitCases)('%s sign', (...c: Case) => {
  it('accepts the smallest amount', async () => {
    expect(await caseErrors(c, 0.01)).toHaveLength(0);
  });

  it('rejects a zero amount', async () => {
    expect(await caseErrors(c, 0)).not.toHaveLength(0);
  });

  it('rejects a negative amount', async () => {
    expect(await caseErrors(c, -5)).not.toHaveLength(0);
  });

  it('rejects an amount just above the maximum', async () => {
    expect(await caseErrors(c, 1e12 + 1)).not.toHaveLength(0);
  });
});
