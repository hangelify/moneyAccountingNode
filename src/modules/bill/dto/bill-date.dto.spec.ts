import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateBillDto } from './create-bill.dto';
import { ConfirmBillDto } from './confirm-bill.dto';
import { UpdateBillDto } from './update-bill.dto';
import { ListBillsQueryDto } from './list-bills-query.dto';

const items = [{ sub_category_id: randomUUID(), product_count: 1, amount: 1 }];

const fields: Array<[string, new () => object, string, object]> = [
  ['CreateBillDto', CreateBillDto, 'bill_date', { total_amount: 1, items }],
  ['ConfirmBillDto', ConfirmBillDto, 'bill_date', { items }],
  ['UpdateBillDto', UpdateBillDto, 'bill_date', {}],
  ['ListBillsQueryDto.date_from', ListBillsQueryDto, 'date_from', {}],
  ['ListBillsQueryDto.date_to', ListBillsQueryDto, 'date_to', {}],
];

const invalid = [
  '2026-05-19T01:00+03:00',
  '2026-05-19T00:00:00.000Z',
  '2026-05-19T00:00',
  '2026-02-30',
  '2026-13-01',
  '19.05.2026',
];

describe.each(fields)('%s date', (_name, Dto, field, base) => {
  const check = async (value: unknown) => {
    const dto = plainToInstance(Dto, { ...base, [field]: value });
    const errors = await validate(dto);
    return errors.filter((e) => e.property === field);
  };

  it('accepts a plain YYYY-MM-DD', async () => {
    expect(await check('2026-05-19')).toHaveLength(0);
  });

  it.each(invalid)('rejects %p', async (value) => {
    expect(await check(value)).toHaveLength(1);
  });
});
