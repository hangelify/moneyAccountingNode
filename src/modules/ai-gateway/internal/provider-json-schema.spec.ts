import { z } from 'zod';
import { toProviderJsonSchema } from './provider-json-schema';
import { ParsedBillSchema } from '../../bill/tasks/schemas/parsed-bill.schema';
import { ParsedAndCategorizedBillSchema } from '../../bill/tasks/schemas/parsed-and-categorized-bill.schema';

describe('toProviderJsonSchema', () => {
  const schema = z.object({
    code: z.enum(['A', 'B']).nullable().catch(null),
    name: z.string().overwrite((s) => s.slice(0, 3)),
  });

  it('keeps the shape and makes every property required', () => {
    expect(toProviderJsonSchema(schema)).toMatchObject({
      type: 'object',
      properties: {
        code: { anyOf: [{ enum: ['A', 'B'] }, { type: 'null' }] },
        name: { type: 'string' },
      },
      required: ['code', 'name'],
      additionalProperties: false,
    });
  });

  // `.catch()` fallbacks are ours, and strict OpenAI mode rejects `default`.
  it('does not leak .catch() fallbacks as `default`', () => {
    expect(JSON.stringify(toProviderJsonSchema(schema))).not.toContain(
      '"default"',
    );
  });

  it.each([
    ['ParsedBillSchema', ParsedBillSchema],
    ['ParsedAndCategorizedBillSchema', ParsedAndCategorizedBillSchema],
  ])('compiles %s without `default`', (_name, s) => {
    expect(JSON.stringify(toProviderJsonSchema(s))).not.toContain('"default"');
  });
});
