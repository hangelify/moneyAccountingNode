import { Capability } from './capability';
import { LlmRequest, LlmResponse } from './llm-request';

export type ProviderName = 'anthropic' | 'openai' | 'deepseek';

export interface LlmCallOptions {
  /** Task-level deadline; implementations must abort in-flight work on it. */
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly name: ProviderName;
  readonly capabilities: ReadonlySet<Capability>;
  readonly isConfigured: boolean;
  readonly defaultModel: string;
  complete(req: LlmRequest, opts?: LlmCallOptions): Promise<LlmResponse>;
  isTransient(err: unknown): boolean;
}

export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS');
