import { z } from 'zod';
import type { DiscoveryService } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { FactoryProvider } from '@nestjs/common';
import { AiGatewayBootstrapper, AiGatewayModule } from './ai-gateway.module';
import { AI_CALL_CONFIG } from './internal/ai-call-config';
import { AI_USAGE_LIMITS } from './internal/ai-usage-limits';
import { AiTask } from './types/ai-task';
import { Capability } from './types/capability';
import { LlmProvider, ProviderName } from './types/llm-provider';

function makeProvider(
  name: ProviderName,
  caps: Capability[],
  opts: { configured?: boolean; defaultModel?: string } = {},
): LlmProvider {
  return {
    name,
    capabilities: new Set<Capability>(caps),
    isConfigured: opts.configured ?? true,
    defaultModel: opts.defaultModel ?? 'gpt-4o',
    complete: () => Promise.resolve({ text: '', model: 'fake' }),
    isTransient: () => false,
  };
}

class VisionTask extends AiTask<{ x: number }, { y: number }> {
  readonly name = 'test.vision';
  readonly requiredCapabilities = new Set<Capability>([
    'text',
    'vision',
    'json',
  ]);
  readonly inputSchema = z.object({ x: z.number() });
  readonly outputSchema = z.object({ y: z.number() });
  buildRequest() {
    return Promise.resolve({ messages: [] });
  }
}

class TextTask extends AiTask<{ x: number }, { y: number }> {
  readonly name = 'test.text';
  readonly requiredCapabilities = new Set<Capability>(['text', 'json']);
  readonly inputSchema = z.object({ x: z.number() });
  readonly outputSchema = z.object({ y: z.number() });
  buildRequest() {
    return Promise.resolve({ messages: [] });
  }
}

function makeDiscovery(instances: unknown[]): DiscoveryService {
  return {
    getProviders: () => instances.map((instance) => ({ instance })),
  } as unknown as DiscoveryService;
}

describe('AiGatewayBootstrapper (boot-time capability check)', () => {
  it('boots successfully when every task has a capable configured provider', () => {
    const providers = [
      makeProvider('anthropic', ['text', 'vision', 'json']),
      makeProvider('deepseek', ['text', 'json']),
    ];
    const discovery = makeDiscovery([new VisionTask(), new TextTask()]);
    const bootstrapper = new AiGatewayBootstrapper(discovery, providers);
    expect(() => bootstrapper.onApplicationBootstrap()).not.toThrow();
  });

  it('fails to boot when a task cannot be served by any configured provider', () => {
    const providers = [makeProvider('deepseek', ['text', 'json'])];
    const discovery = makeDiscovery([new VisionTask(), new TextTask()]);
    const bootstrapper = new AiGatewayBootstrapper(discovery, providers);
    expect(() => bootstrapper.onApplicationBootstrap()).toThrow(
      /test\.vision.*vision/,
    );
  });

  it('ignores !isConfigured providers when checking capability', () => {
    const providers = [
      makeProvider('anthropic', ['text', 'vision', 'json'], {
        configured: false,
      }),
      makeProvider('deepseek', ['text', 'json']),
    ];
    const discovery = makeDiscovery([new TextTask()]);
    const bootstrapper = new AiGatewayBootstrapper(discovery, providers);
    expect(() => bootstrapper.onApplicationBootstrap()).not.toThrow();
  });

  it('throws when an unconfigured provider is the only one capable', () => {
    const providers = [
      makeProvider('anthropic', ['text', 'vision', 'json'], {
        configured: false,
      }),
    ];
    const discovery = makeDiscovery([new VisionTask()]);
    const bootstrapper = new AiGatewayBootstrapper(discovery, providers);
    expect(() => bootstrapper.onApplicationBootstrap()).toThrow(/test\.vision/);
  });

  it('ignores non-AiTask providers discovered by DiscoveryService', () => {
    const providers = [makeProvider('deepseek', ['text', 'json'])];
    const discovery = makeDiscovery([
      new TextTask(),
      { not: 'a task' },
      'string-instance',
      null,
      undefined,
    ]);
    const bootstrapper = new AiGatewayBootstrapper(discovery, providers);
    expect(() => bootstrapper.onApplicationBootstrap()).not.toThrow();
  });
});

class OverrideTask extends AiTask<{ x: number }, { y: number }> {
  readonly name = 'test.override';
  readonly requiredCapabilities = new Set<Capability>(['text', 'json']);
  readonly inputSchema = z.object({ x: z.number() });
  readonly outputSchema = z.object({ y: z.number() });
  buildRequest() {
    return Promise.resolve({ messages: [] });
  }
  override readonly modelOverrides = {
    deepseek: 'deepseek-unpriced',
    anthropic: 'claude-unpriced',
  };
}

describe('AiGatewayBootstrapper (boot-time pricing check)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  function pricingWarnings(): string[] {
    return warn.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((m) => m.includes('pricing'));
  }

  function boot(providers: LlmProvider[], tasks: unknown[]): void {
    new AiGatewayBootstrapper(
      makeDiscovery(tasks),
      providers,
    ).onApplicationBootstrap();
  }

  it('does not warn when every configured model is priced', () => {
    boot(
      [
        makeProvider('anthropic', ['text', 'json'], {
          defaultModel: 'claude-sonnet-4-6',
        }),
        makeProvider('openai', ['text', 'json'], {
          defaultModel: 'gpt-4o-2024-08-06',
        }),
      ],
      [new TextTask()],
    );
    expect(pricingWarnings()).toEqual([]);
  });

  it("warns when a configured provider's default model has no price", () => {
    boot(
      [
        makeProvider('deepseek', ['text', 'json'], {
          defaultModel: 'deepseek-mystery',
        }),
      ],
      [new TextTask()],
    );
    const msgs = pricingWarnings();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("'deepseek-mystery'");
    expect(msgs[0]).toContain('deepseek default model');
  });

  it("warns when a task's model override for a configured provider has no price", () => {
    boot([makeProvider('deepseek', ['text', 'json'])], [new OverrideTask()]);
    const msgs = pricingWarnings();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("'deepseek-unpriced'");
    expect(msgs[0]).toContain("task 'test.override' (deepseek)");
  });

  it('ignores defaults and overrides of providers that are not configured', () => {
    boot(
      [
        makeProvider('deepseek', ['text', 'json'], {
          defaultModel: 'deepseek-flash',
        }),
        makeProvider('anthropic', ['text', 'json'], {
          configured: false,
          defaultModel: 'claude-unpriced-default',
        }),
      ],
      [new OverrideTask()],
    );
    expect(pricingWarnings().join('\n')).not.toContain('claude-unpriced');
  });
});

describe('AiGatewayModule.forRoot (call config)', () => {
  const saved = process.env.AI_TRANSIENT_RETRY_ATTEMPTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.AI_TRANSIENT_RETRY_ATTEMPTS;
    else process.env.AI_TRANSIENT_RETRY_ATTEMPTS = saved;
  });

  function configFactory(): () => unknown {
    const mod = AiGatewayModule.forRoot({ providers: [] });
    const provider = (mod.providers ?? []).find(
      (p) =>
        typeof p === 'object' && 'provide' in p && p.provide === AI_CALL_CONFIG,
    );
    expect(provider).toBeDefined();
    return (provider as FactoryProvider<unknown>).useFactory as () => unknown;
  }

  it('provides the parsed AI call config', () => {
    process.env.AI_TRANSIENT_RETRY_ATTEMPTS = '1';
    expect(configFactory()()).toMatchObject({ retryAttempts: 1 });
  });

  it('fails startup on an invalid AI env value', () => {
    process.env.AI_TRANSIENT_RETRY_ATTEMPTS = 'NaN';
    expect(() => configFactory()()).toThrow('AI_TRANSIENT_RETRY_ATTEMPTS');
  });
});

describe('AiGatewayModule.forRoot (usage limits)', () => {
  const saved = process.env.AI_MAX_CONCURRENCY;
  afterEach(() => {
    if (saved === undefined) delete process.env.AI_MAX_CONCURRENCY;
    else process.env.AI_MAX_CONCURRENCY = saved;
  });

  it('provides and exports the parsed usage limits', () => {
    process.env.AI_MAX_CONCURRENCY = '7';
    const mod = AiGatewayModule.forRoot({ providers: [] });
    const provider = (mod.providers ?? []).find(
      (p) =>
        typeof p === 'object' &&
        'provide' in p &&
        p.provide === AI_USAGE_LIMITS,
    ) as FactoryProvider<unknown> | undefined;

    expect(provider).toBeDefined();
    expect((provider!.useFactory as () => unknown)()).toMatchObject({
      maxConcurrency: 7,
    });
    expect(mod.exports).toContain(AI_USAGE_LIMITS);
  });
});
