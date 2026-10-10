import { Capability } from '../../types/capability';
import {
  LlmCallOptions,
  LlmProvider,
  ProviderName,
} from '../../types/llm-provider';
import { LlmRequest, LlmResponse } from '../../types/llm-request';

export type FakeProviderScript = Array<
  (opts?: LlmCallOptions) => Promise<LlmResponse>
>;

export class FakeLlmProvider implements LlmProvider {
  readonly isConfigured = true;
  readonly defaultModel: string;
  private callIdx = 0;

  constructor(
    readonly name: ProviderName,
    readonly capabilities: ReadonlySet<Capability>,
    private readonly script: FakeProviderScript,
    opts?: { defaultModel?: string },
  ) {
    this.defaultModel = opts?.defaultModel ?? 'fake-model';
  }

  complete(_req: LlmRequest, opts?: LlmCallOptions): Promise<LlmResponse> {
    const step = this.script[this.callIdx++];
    if (!step) {
      return Promise.reject(
        new Error(
          `FakeLlmProvider '${this.name}' had no scripted call #${this.callIdx}`,
        ),
      );
    }
    return step(opts);
  }

  isTransient(err: unknown): boolean {
    return (err as { transient?: boolean })?.transient === true;
  }
}
