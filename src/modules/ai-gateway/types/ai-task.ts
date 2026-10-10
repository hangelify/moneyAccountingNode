import { ZodType } from 'zod';
import { Capability } from './capability';
import { LlmRequest } from './llm-request';
import { ProviderName } from './llm-provider';

export type TaskRequest = Omit<LlmRequest, 'jsonSchema' | 'modelOverride'>;

/** A task's validated output plus the id of its `ai_requests` audit row. */
export interface AiTaskResult<Out> {
  data: Out;
  requestId: string;
}

export abstract class AiTask<In, Out> {
  abstract readonly name: string;
  abstract readonly requiredCapabilities: ReadonlySet<Capability>;
  abstract readonly inputSchema: ZodType<In>;
  abstract readonly outputSchema: ZodType<Out>;
  readonly modelOverrides?: Partial<Record<ProviderName, string>>;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;

  abstract buildRequest(input: In): Promise<TaskRequest>;
}
