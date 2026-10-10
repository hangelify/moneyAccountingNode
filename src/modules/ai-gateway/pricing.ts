export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

/**
 * Standard (non-batch, uncached) USD prices per 1M tokens, verified 2026-10-10:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * - OpenAI: https://developers.openai.com/api/docs/pricing
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing — peak-hour
 *   rates (off-peak is half), so the daily budget never undercounts.
 *   `deepseek-chat` was retired on 2026-07-24 and has no price any more.
 *
 * Keys are base model ids; dated snapshots resolve via `findModelPricing`.
 * A snapshot priced apart from its base model needs its own entry.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-opus-4-7': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-opus-4-6': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-sonnet-4-5': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-haiku-4-5': { inputPer1M: 1.0, outputPer1M: 5.0 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
  'gpt-4o-2024-05-13': { inputPer1M: 5.0, outputPer1M: 15.0 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'deepseek-flash': { inputPer1M: 0.3, outputPer1M: 1.2 },
  // Legacy name, served by V4.1 Flash and billed at the Flash price.
  'deepseek-v4-flash': { inputPer1M: 0.3, outputPer1M: 1.2 },
  'deepseek-v4-pro': { inputPer1M: 1.32, outputPer1M: 3.96 },
};

/**
 * Exact id first, then the longest table key the id extends with a `-`
 * (`claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`).
 */
export function findModelPricing(model: string): ModelPricing | null {
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  let best: string | undefined;
  for (const key of Object.keys(MODEL_PRICING)) {
    if (
      model.startsWith(`${key}-`) &&
      (best === undefined || key.length > best.length)
    ) {
      best = key;
    }
  }
  return best === undefined ? null : MODEL_PRICING[best];
}

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
}

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostBreakdown | null {
  const p = findModelPricing(model);
  if (!p) return null;
  const inputUsd = (inputTokens * p.inputPer1M) / 1_000_000;
  const outputUsd = (outputTokens * p.outputPer1M) / 1_000_000;
  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}
