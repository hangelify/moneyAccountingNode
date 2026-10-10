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

export interface AiGatewayOptions {
  providers: Type<LlmProvider>[];
}

@Injectable()
export class AiGatewayBootstrapper implements OnApplicationBootstrap {
  private readonly log = new Logger('AiGatewayModule');

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(LLM_PROVIDERS) private readonly providers: LlmProvider[],
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
        throw new Error(
          `No configured AI provider satisfies task '${task.name}' (required: ${Array.from(
            task.requiredCapabilities,
          ).join(', ')})`,
        );
      }
      this.log.log(
        `Task '${task.name}' can run on: ${capable.map((p) => p.name).join(', ')}`,
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
