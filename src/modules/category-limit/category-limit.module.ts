import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Category } from '../../entities/category.entity';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { CategoryLimit } from '../../entities/category-limit.entity';
import { CategoryLimitCarryStop } from '../../entities/category-limit-carry-stop.entity';
import { CategoryLimitController } from './category-limit.controller';
import { CategoryLimitService } from './category-limit.service';
import { LimitReportService } from './limit-report.service';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      CategoryLimit,
      CategoryLimitCarryStop,
      Category,
      Household,
      HouseholdMember,
    ]),
    ExchangeRateModule,
  ],
  controllers: [CategoryLimitController],
  providers: [CategoryLimitService, LimitReportService],
  exports: [CategoryLimitService],
})
export class CategoryLimitModule {}
