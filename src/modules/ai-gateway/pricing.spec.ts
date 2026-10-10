import { MODEL_PRICING, computeCostUsd, findModelPricing } from './pricing';

describe('pricing', () => {
  it('has entries for the default models named in .env.example', () => {
    expect(MODEL_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(MODEL_PRICING['gpt-4o']).toBeDefined();
    // DEEPSEEK_MODEL=deepseek-chat is retired by DeepSeek and left unpriced
    // on purpose: the boot check warns about it.
    expect(MODEL_PRICING['deepseek-chat']).toBeUndefined();
  });

  it('prices claude-opus-4-7 at $5/$25 per 1M tokens', () => {
    expect(MODEL_PRICING['claude-opus-4-7']).toEqual({
      inputPer1M: 5,
      outputPer1M: 25,
    });
  });

  it('computes cost per 1M tokens correctly', () => {
    const r = computeCostUsd('gpt-4o', 1_000_000, 1_000_000);
    expect(r).toEqual({ inputUsd: 2.5, outputUsd: 10, totalUsd: 12.5 });
  });

  it('returns null when model is not priced', () => {
    expect(computeCostUsd('unknown-model', 100, 100)).toBeNull();
  });

  it('handles zero tokens', () => {
    const r = computeCostUsd('gpt-4o', 0, 0);
    expect(r).toEqual({ inputUsd: 0, outputUsd: 0, totalUsd: 0 });
  });

  describe('findModelPricing', () => {
    it('matches an exact model id', () => {
      expect(findModelPricing('gpt-4o-mini')).toBe(
        MODEL_PRICING['gpt-4o-mini'],
      );
    });

    it('resolves a dated snapshot id to its base model', () => {
      expect(findModelPricing('claude-sonnet-4-5-20250929')).toBe(
        MODEL_PRICING['claude-sonnet-4-5'],
      );
      expect(findModelPricing('gpt-4o-2024-08-06')).toBe(
        MODEL_PRICING['gpt-4o'],
      );
    });

    it('picks the longest matching prefix', () => {
      expect(findModelPricing('gpt-4o-mini-2024-07-18')).toBe(
        MODEL_PRICING['gpt-4o-mini'],
      );
    });

    it('only matches a prefix on a "-" boundary', () => {
      expect(findModelPricing('gpt-4omni')).toBeNull();
      expect(findModelPricing('claude-haiku-4-50')).toBeNull();
    });

    it('prefers an exact snapshot entry priced apart from its base model', () => {
      expect(findModelPricing('gpt-4o-2024-05-13')).toEqual({
        inputPer1M: 5,
        outputPer1M: 15,
      });
    });

    it('returns null for an unknown model', () => {
      expect(findModelPricing('unknown-model')).toBeNull();
    });

    it('is used by computeCostUsd', () => {
      expect(computeCostUsd('claude-opus-4-7-20260101', 1_000_000, 0)).toEqual({
        inputUsd: 5,
        outputUsd: 0,
        totalUsd: 5,
      });
    });
  });
});
