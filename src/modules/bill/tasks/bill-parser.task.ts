import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AiTask, TaskRequest } from '../../ai-gateway/types/ai-task';
import { Capability } from '../../ai-gateway/types/capability';
import { ParsedBill, ParsedBillSchema } from './schemas/parsed-bill.schema';
import { BILL_PARSER_SYSTEM_PROMPT } from './prompts';

const InputSchema = z.object({
  image: z.instanceof(Buffer),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  hint: z.string().optional(),
});
type Input = z.infer<typeof InputSchema>;

@Injectable()
export class BillParserTask extends AiTask<Input, ParsedBill> {
  readonly name = 'bill.parse';
  readonly requiredCapabilities = new Set<Capability>([
    'text',
    'vision',
    'json',
  ]);
  readonly inputSchema = InputSchema;
  readonly outputSchema = ParsedBillSchema;
  override readonly temperature = 0;

  buildRequest(input: Input): Promise<TaskRequest> {
    return Promise.resolve({
      messages: [
        { role: 'system', text: BILL_PARSER_SYSTEM_PROMPT },
        {
          role: 'user',
          text: input.hint
            ? `Extract the bill data. Context hint: ${input.hint}`
            : 'Extract the bill data.',
          images: [{ data: input.image, mediaType: input.mediaType }],
        },
      ],
    });
  }
}
