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
import { AuthModule } from './modules/auth';
import { MailModule } from './modules/mail';
import { BudgetModule } from './modules/budget';
import { PlaningHorizonModule } from './modules/planing-horizon';
import { CategoryModule } from './modules/category';
import { SubCategoryModule } from './modules/sub-category';
import { StorageModule } from './modules/storage';
import { AiGatewayModule } from './modules/ai-gateway';
import { AnthropicProvider } from './modules/ai-gateway';
import { OpenAiProvider } from './modules/ai-gateway';
import { DeepSeekProvider } from './modules/ai-gateway';
import { BillModule } from './modules/bill';
import { BillBatchModule } from './modules/bill';
import { MarketModule } from './modules/market';
import { HouseholdModule } from './modules/household';
import { RetentionModule } from './modules/retention';
import { ExchangeRateModule } from './modules/exchange-rate';
import { HealthModule } from './modules/health';

export const APP_THROTTLERS = [{ name: 'default', ttl: 60_000, limit: 100 }];

@Module({
  imports: [
    MikroOrmModule.forRootAsync({ useFactory: createMikroOrmConfig }),
    ScheduleModule.forRoot(),
    MailModule,
    AuthModule,
    BudgetModule,
    PlaningHorizonModule,
    CategoryModule,
    SubCategoryModule,
    StorageModule,
    AiGatewayModule.forRoot({
      providers: [AnthropicProvider, OpenAiProvider, DeepSeekProvider],
    }),
    // Before BillModule: Express matches routes in registration order, and
    // BillController's GET bills/:id would otherwise catch GET bills/events.
    BillBatchModule.register(),
    BillModule,
    MarketModule,
    HouseholdModule,
    RetentionModule,
    ExchangeRateModule,
    HealthModule,
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
