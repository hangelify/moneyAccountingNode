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

// Anthropic structured output answers a 400 to these keywords. The task's
// zod schema still checks every bound once the answer is back.
const ANTHROPIC_UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  // Only simple regexes compile; `format` already covers zod's date pattern.
  'pattern',
]);

/** The same schema without the keywords Anthropic structured output rejects. */
export function toAnthropicOutputSchema(schema: object): object {
  return stripKeywords(schema) as object;
}

function stripKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripKeywords);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node) as [string, unknown][]) {
    if (ANTHROPIC_UNSUPPORTED_KEYWORDS.has(key)) continue;
    // Property names are data, not keywords: a field named `pattern` stays.
    out[key] =
      key === 'properties' && value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value).map(([name, v]) => [name, stripKeywords(v)]),
          )
        : stripKeywords(value);
  }
  return out;
}
