import { ProviderResolver } from './provider-resolver';
import { LlmProvider, ProviderName } from '../types/llm-provider';
import { Capability } from '../types/capability';

function fake(name: ProviderName, caps: Capability[]): LlmProvider {
  return {
    name,
    capabilities: new Set(caps),
    isConfigured: true,
    defaultModel: 'x',
    complete: () => Promise.resolve({ text: '', model: 'x' }),
    isTransient: () => false,
  };
}

describe('ProviderResolver', () => {
  const anth = fake('anthropic', ['text', 'vision', 'json']);
  const oai = fake('openai', ['text', 'vision', 'json']);
  const dsk = fake('deepseek', ['text', 'json']);

  it('returns only providers whose caps are a superset of required', () => {
    const r = new ProviderResolver([anth, oai, dsk]);
    const candidates = r.candidates(
      new Set<Capability>(['text', 'vision', 'json']),
    );
    expect(candidates.map((p) => p.name)).toEqual(['anthropic', 'openai']);
  });

  it('preserves registration order as priority', () => {
    const r = new ProviderResolver([dsk, oai, anth]);
    const candidates = r.candidates(new Set<Capability>(['text', 'json']));
    expect(candidates.map((p) => p.name)).toEqual([
      'deepseek',
      'openai',
      'anthropic',
    ]);
  });

  it('returns empty when nothing matches', () => {
    const r = new ProviderResolver([dsk]);
    expect(r.candidates(new Set<Capability>(['vision']))).toEqual([]);
  });
});
