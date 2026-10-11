import {
  DynamicModule,
  Module,
  Logger,
  OnApplicationBootstrap,
  Injectable,
  Type,
  Provider,
  Inject,
} from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { AiRequest } from '../../entities/ai-request.entity';
import { AiRequestAttempt } from '../../entities/ai-request-attempt.entity';
import { StorageModule } from '../storage/storage.module';
import { AiGatewayService } from './ai-gateway.service';
import { AiRequestLogger } from './internal/ai-request-logger';
import { AiAuditSweeper } from './internal/ai-audit-sweeper';
import { LLM_PROVIDERS, LlmProvider } from './types/llm-provider';
import { AiTask } from './types/ai-task';
import { AI_CALL_CONFIG, loadAiCallConfig } from './internal/ai-call-config';
import { AI_USAGE_LIMITS, loadAiUsageLimits } from './internal/ai-usage-limits';
import { AI_REQUIRED, loadAiRequired } from './internal/ai-required';
import { findModelPricing } from './pricing';

export interface AiGatewayOptions {
  providers: Type<LlmProvider>[];
}

@Injectable()
export class AiGatewayBootstrapper implements OnApplicationBootstrap {
  private readonly log = new Logger('AiGatewayModule');

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(LLM_PROVIDERS) private readonly providers: LlmProvider[],
    @Inject(AI_REQUIRED) private readonly aiRequired: boolean,
  ) {}

  onApplicationBootstrap(): void {
    const configured = this.providers.filter((p) => p.isConfigured);
    const skipped = this.providers.filter((p) => !p.isConfigured);

    this.log.log(
      `Configured providers: ${
        configured.map((p) => p.name).join(', ') || '(none)'
      }`,
    );
    if (skipped.length) {
      this.log.warn(
        `Skipped providers (no API key): ${skipped.map((p) => p.name).join(', ')}`,
      );
    }

    const tasks = this.discovery
      .getProviders()
      .map((w) => w.instance as unknown)
      .filter((i): i is AiTask<unknown, unknown> => i instanceof AiTask);

    for (const task of tasks) {
      const capable = configured.filter((p) => {
        for (const c of task.requiredCapabilities) {
          if (!p.capabilities.has(c)) return false;
        }
        return true;
      });
      if (capable.length === 0) {
        const problem = `No configured AI provider satisfies task '${task.name}' (required: ${Array.from(
          task.requiredCapabilities,
        ).join(', ')})`;
        if (this.aiRequired) throw new Error(problem);
        this.log.warn(
          `${problem}; AI_REQUIRED=false, so its endpoints will answer 503`,
        );
        continue;
      }
      this.log.log(
        `Task '${task.name}' can run on: ${capable.map((p) => p.name).join(', ')}`,
      );
    }

    this.warnUnpricedModels(configured, tasks);
  }

  /** Unpriced models leave cost null, so the daily budget does not see them. */
  private warnUnpricedModels(
    configured: LlmProvider[],
    tasks: AiTask<unknown, unknown>[],
  ): void {
    const usedBy = new Map<string, string[]>();
    const use = (model: string, where: string) =>
      usedBy.set(model, [...(usedBy.get(model) ?? []), where]);

    for (const p of configured) use(p.defaultModel, `${p.name} default model`);
    for (const task of tasks) {
      for (const p of configured) {
        const model = task.modelOverrides?.[p.name];
        if (model) use(model, `task '${task.name}' (${p.name})`);
      }
    }

    for (const [model, where] of usedBy) {
      if (findModelPricing(model)) continue;
      this.log.warn(
        `No pricing entry for model '${model}' used by ${where.join(', ')} — ` +
          'its cost will be null and not count towards AI_DAILY_BUDGET_USD',
      );
    }
  }
}

@Module({})
export class AiGatewayModule {
  static forRoot(options: AiGatewayOptions): DynamicModule {
    const providerClasses = options.providers;
    const providers: Provider[] = [
      // Parsed once at boot: an invalid AI_* value fails startup.
      { provide: AI_CALL_CONFIG, useFactory: () => loadAiCallConfig() },
      { provide: AI_USAGE_LIMITS, useFactory: () => loadAiUsageLimits() },
      { provide: AI_REQUIRED, useFactory: () => loadAiRequired() },
      ...providerClasses,
      {
        provide: LLM_PROVIDERS,
        useFactory: (...instances: LlmProvider[]) => instances,
        inject: providerClasses,
      },
      AiRequestLogger,
      AiAuditSweeper,
      AiGatewayService,
      AiGatewayBootstrapper,
    ];

    return {
      module: AiGatewayModule,
      imports: [
        DiscoveryModule,
        StorageModule,
        MikroOrmModule.forFeature([AiRequest, AiRequestAttempt]),
      ],
      providers,
      // Limits are exported for the per-user AI throttler on HTTP routes.
      exports: [AiGatewayService, AI_USAGE_LIMITS],
      global: true,
    };
  }
}
