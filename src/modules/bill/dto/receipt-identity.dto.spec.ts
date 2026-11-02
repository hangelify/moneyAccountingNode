import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ConfirmBillDto } from './confirm-bill.dto';
import { CreateBillDto } from './create-bill.dto';
import { UpdateBillDto } from './update-bill.dto';

const item = { sub_category_id: randomUUID(), product_count: 1, amount: 12.5 };
const bodies = {
  ConfirmBillDto: [
    ConfirmBillDto,
    { bill_date: '2026-05-19', total_amount: 12.5, items: [item] },
  ],
  CreateBillDto: [
    CreateBillDto,
    { bill_date: '2026-05-19', total_amount: 12.5, items: [item] },
  ],
  UpdateBillDto: [UpdateBillDto, {}],
} as const;

describe.each(Object.entries(bodies))(
  '%s receipt identity',
  (_, [cls, base]) => {
    async function errorProps(extra: object) {
      const errors = await validate(
        plainToInstance(cls as new () => object, { ...base, ...extra }),
      );
      return errors.map((e) => e.property);
    }

    it('accepts a full receipt identity', async () => {
      expect(
        await errorProps({
          fiscal_register_id: 'J403001234',
          fiscal_receipt_number: '0042',
          purchase_time: '09:05',
        }),
      ).toEqual([]);
    });

    it.each(['9:5', '24:00', '12:60', '12:5', '1205'])(
      'rejects purchase_time %s',
      async (purchase_time) => {
        expect(await errorProps({ purchase_time })).toContain('purchase_time');
      },
    );

    it.each([
      ['fiscal_register_id', ''],
      ['fiscal_register_id', 'x'.repeat(65)],
      ['fiscal_receipt_number', ''],
      ['fiscal_receipt_number', 42],
    ])('rejects %s %p', async (field, value) => {
      expect(await errorProps({ [field]: value })).toContain(field);
    });
  },
);
