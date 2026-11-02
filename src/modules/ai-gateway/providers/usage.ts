import { LlmResponse } from '../types/llm-request';

/**
 * Token usage as reported by the provider, or undefined when either count is
 * missing: the audit then stores null instead of a made-up zero cost.
 */
export function toUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): LlmResponse['usage'] {
  if (inputTokens == null || outputTokens == null) return undefined;
  return { inputTokens, outputTokens };
}
