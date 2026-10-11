import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { createMikroOrmConfig } from './mikro-orm.config';
import { redisConnectionOptions } from './config/redis';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { BudgetModule } from './modules/budget/budget.module';
import { PlaningHorizonModule } from './modules/planing-horizon/planing-horizon.module';
import { CategoryModule } from './modules/category/category.module';
import { SubCategoryModule } from './modules/sub-category/sub-category.module';
import { StorageModule } from './modules/storage/storage.module';
import { AiGatewayModule } from './modules/ai-gateway/ai-gateway.module';
import { AnthropicProvider } from './modules/ai-gateway/providers/anthropic.provider';
import { OpenAiProvider } from './modules/ai-gateway/providers/openai.provider';
import { DeepSeekProvider } from './modules/ai-gateway/providers/deepseek.provider';
import { BillModule } from './modules/bill/bill.module';
import { MarketModule } from './modules/market/market.module';
import { HouseholdModule } from './modules/household/household.module';
import { RetentionModule } from './modules/retention/retention.module';

export const APP_THROTTLERS = [{ name: 'default', ttl: 60_000, limit: 100 }];

@Module({
  imports: [
    MikroOrmModule.forRootAsync({ useFactory: createMikroOrmConfig }),
    ScheduleModule.forRoot(),
    AuthModule,
    BudgetModule,
    PlaningHorizonModule,
    CategoryModule,
    SubCategoryModule,
    StorageModule,
    AiGatewayModule.forRoot({
      providers: [AnthropicProvider, OpenAiProvider, DeepSeekProvider],
    }),
    BillModule,
    MarketModule,
    HouseholdModule,
    RetentionModule,
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        throttlers: APP_THROTTLERS,
        storage: new ThrottlerStorageRedisService(redisConnectionOptions()),
      }),
    }),
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
