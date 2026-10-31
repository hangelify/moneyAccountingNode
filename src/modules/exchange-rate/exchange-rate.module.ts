import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ExchangeRate } from '../../entities/exchange-rate.entity';
import { ExchangeRateDay } from '../../entities/exchange-rate-day.entity';
import { ExchangeRateService } from './exchange-rate.service';
import { MdlMdClient } from './mdl-md.client';
import { EXCHANGE_RATE_PROVIDER } from './exchange-rate.provider';
import {
  EXCHANGE_RATE_CONFIG,
  readExchangeRateConfig,
} from './exchange-rate.env';

@Module({
  imports: [MikroOrmModule.forFeature([ExchangeRate, ExchangeRateDay])],
  providers: [
    { provide: EXCHANGE_RATE_CONFIG, useFactory: readExchangeRateConfig },
    { provide: EXCHANGE_RATE_PROVIDER, useClass: MdlMdClient },
    ExchangeRateService,
  ],
  exports: [ExchangeRateService],
})
export class ExchangeRateModule {}
