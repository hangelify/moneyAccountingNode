import { z } from 'zod';

export const CategorizedItemSchema = z.object({
  item_index: z.number().int(),
  sub_category_id: z.string().uuid().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),
});
export const CategorizedBillSchema = z.object({
  items: z.array(CategorizedItemSchema),
});
export type CategorizedBill = z.infer<typeof CategorizedBillSchema>;
