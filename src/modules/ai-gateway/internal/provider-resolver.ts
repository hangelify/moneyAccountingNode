import { Capability } from '../types/capability';
import { LlmProvider } from '../types/llm-provider';

export class ProviderResolver {
  constructor(private readonly providers: readonly LlmProvider[]) {}

  candidates(required: ReadonlySet<Capability>): LlmProvider[] {
    return this.providers.filter((p) => {
      for (const c of required) {
        if (!p.capabilities.has(c)) return false;
      }
      return true;
    });
  }
}
