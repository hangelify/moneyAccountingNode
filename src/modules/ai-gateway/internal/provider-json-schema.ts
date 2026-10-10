import { z } from 'zod';

/**
 * JSON Schema a provider is asked to fill. A `.catch()` fallback is how we
 * repair a bad answer, not a hint for the model, and strict OpenAI structured
 * output rejects the `default` keyword zod emits for it.
 */
export function toProviderJsonSchema(schema: z.ZodType): object {
  return z.toJSONSchema(schema, {
    override: (ctx) => {
      if (ctx.zodSchema._zod.def.type === 'catch') {
        delete ctx.jsonSchema.default;
      }
    },
  });
}
