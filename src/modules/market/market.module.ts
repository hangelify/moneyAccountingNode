import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Market } from '../../entities/market.entity';
import { Household } from '../../entities/household.entity';
import { HouseholdMemberGuard } from '../household/guards/household-member.guard';
import { HouseholdMember } from '../../entities/household-member.entity';
import { MarketService } from './market.service';
import { MarketController } from './market.controller';

@Module({
  imports: [MikroOrmModule.forFeature([Market, Household, HouseholdMember])],
  controllers: [MarketController],
  providers: [MarketService, HouseholdMemberGuard],
  exports: [MarketService],
})
export class MarketModule {}
