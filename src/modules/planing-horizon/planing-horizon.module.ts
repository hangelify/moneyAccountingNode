import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PlaningHorizon } from '../../entities/planing-horizon.entity';
import { Budget } from '../../entities/budget.entity';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { PlaningHorizonService } from './planing-horizon.service';
import { PlaningHorizonController } from './planing-horizon.controller';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      PlaningHorizon,
      Budget,
      Household,
      HouseholdMember,
    ]),
  ],
  controllers: [PlaningHorizonController],
  providers: [PlaningHorizonService],
  exports: [PlaningHorizonService],
})
export class PlaningHorizonModule {}
