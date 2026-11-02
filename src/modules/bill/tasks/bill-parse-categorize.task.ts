import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AiTask, TaskRequest } from '../../ai-gateway/types/ai-task';
import { Capability } from '../../ai-gateway/types/capability';
import {
  ParsedAndCategorizedBill,
  ParsedAndCategorizedBillSchema,
} from './schemas/parsed-and-categorized-bill.schema';
import { BILL_PARSE_CATEGORIZE_SYSTEM_PROMPT } from './prompts';

const SubCategoryInfoSchema = z.object({
  id: z.string().uuid(),
  category_name: z.string(),
  sub_category_name: z.string(),
});

const InputSchema = z.object({
  image: z.instanceof(Buffer),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  subcategories: z.array(SubCategoryInfoSchema),
});
type Input = z.infer<typeof InputSchema>;

@Injectable()
export class BillParseCategorizeTask extends AiTask<
  Input,
  ParsedAndCategorizedBill
> {
  readonly name = 'bill.parse-categorize';
  readonly requiredCapabilities = new Set<Capability>([
    'text',
    'vision',
    'json',
  ]);
  readonly inputSchema = InputSchema;
  readonly outputSchema = ParsedAndCategorizedBillSchema;
  override readonly temperature = 0;

  buildRequest(input: Input): Promise<TaskRequest> {
    const tree = input.subcategories
      .map((s) => `${s.id} | ${s.category_name} > ${s.sub_category_name}`)
      .join('\n');

    return Promise.resolve({
      messages: [
        { role: 'system', text: BILL_PARSE_CATEGORIZE_SYSTEM_PROMPT },
        {
          role: 'user',
          text:
            `Available sub-categories (sub_category_id | category > sub_category):\n${tree}\n\n` +
            `Extract the bill data and categorize each item.`,
          images: [{ data: input.image, mediaType: input.mediaType }],
        },
      ],
    });
  }
}
