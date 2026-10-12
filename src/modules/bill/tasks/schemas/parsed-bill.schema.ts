import { z } from 'zod';
import { Currency } from '../../../../types/currency.enum';

// The model is paid for before its answer is validated, so a doubtful
// optional field becomes null (`.catch(null)`) instead of failing the whole
// response. Bounds mirror the columns the draft is saved into.

/** bill_sub_categories.raw_name is varchar(255). */
export const MAX_ITEM_NAME_LENGTH = 255;
/**
 * bills.amount and bill_sub_categories.amount are decimal(19,2); kept far
 * below that so cents stay exact in a JS number and line sums still fit.
 */
export const MAX_AMOUNT = 1e13;
/** bill_sub_categories.price_per_unit is decimal(10,2). */
export const MAX_PRICE_PER_UNIT = 99_999_999.99;
/** bill_sub_categories.product_weight is decimal(10,3). */
export const MAX_WEIGHT_KG = 9_999_999.999;
/** bill_sub_categories.product_count is int4; quantities of a category add up. */
export const MAX_QUANTITY = 1_000_000;

export const ITEM_UNITS = ['kg', 'g', 'l', 'ml', 'piece'] as const;

const bounded = (max: number) => z.number().min(-max).max(max);

export const ParsedBillItemSchema = z.object({
  name: z
    .string()
    .overwrite((s) => s.slice(0, MAX_ITEM_NAME_LENGTH))
    .describe('Product name as printed on the bill'),
  quantity: z.number().int().min(0).max(MAX_QUANTITY).nullable().catch(null),
  unit: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(ITEM_UNITS))
    .nullable()
    .catch(null),
  weight_kg: bounded(MAX_WEIGHT_KG)
    .nullable()
    .catch(null)
    .describe('Weight in kilograms if weight-priced'),
  price_per_kg: bounded(MAX_PRICE_PER_UNIT).nullable().catch(null),
  final_price: bounded(MAX_AMOUNT).describe(
    'Amount paid for this line after its discount (and its share of any whole-receipt discount), in bill currency',
  ),
});

export const ParsedBillSchema = z.object({
  // A malformed verdict counts as a receipt: an empty item list still
  // rejects a non-receipt, and a real receipt's paid parse is not lost.
  is_receipt: z
    .boolean()
    .catch(true)
    .describe('false when the photo is not a purchase receipt'),
  market_name: z.string().nullable(),
  bill_date: z.iso
    .date()
    .nullable()
    .catch(null)
    .describe('ISO-8601 date (YYYY-MM-DD)'),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.enum(Currency))
    .nullable()
    .catch(null)
    .describe('ISO-4217 currency code'),
  total_amount: bounded(MAX_AMOUNT).nullable().catch(null),
  items: z.array(ParsedBillItemSchema),
});
export type ParsedBill = z.infer<typeof ParsedBillSchema>;
export type ParsedBillItem = z.infer<typeof ParsedBillItemSchema>;
