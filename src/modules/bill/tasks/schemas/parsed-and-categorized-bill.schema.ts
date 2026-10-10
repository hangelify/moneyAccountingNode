import { z } from 'zod';
import { ParsedBillItemSchema, ParsedBillSchema } from './parsed-bill.schema';

// A bad categorization must not throw away the paid-for parse: the field
// becomes null, and unknown sub-category ids are dropped by the caller.
export const ParsedAndCategorizedBillItemSchema = ParsedBillItemSchema.extend({
  sub_category_id: z.uuid().nullable().catch(null),
  category_confidence: z.number().min(0).max(1).nullable().catch(null),
  category_reasoning: z.string().nullable().catch(null),
});

export const ParsedAndCategorizedBillSchema = ParsedBillSchema.omit({
  items: true,
}).extend({
  items: z.array(ParsedAndCategorizedBillItemSchema),
});

export type ParsedAndCategorizedBill = z.infer<
  typeof ParsedAndCategorizedBillSchema
>;
export type ParsedAndCategorizedBillItem = z.infer<
  typeof ParsedAndCategorizedBillItemSchema
>;
