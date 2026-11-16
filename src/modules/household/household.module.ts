import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { HouseholdInvite } from '../../entities/household-invite.entity';
import { CategoryModule } from '../category/category.module';
import { HouseholdService } from './household.service';
import { HouseholdController } from './household.controller';
import { HouseholdMemberGuard } from './guards/household-member.guard';
import { HOUSEHOLD_LIMITS, readHouseholdLimits } from './household-limits.env';

@Module({
  imports: [
    MikroOrmModule.forFeature([Household, HouseholdMember, HouseholdInvite]),
    CategoryModule,
  ],
  controllers: [HouseholdController],
  providers: [
    HouseholdService,
    HouseholdMemberGuard,
    { provide: HOUSEHOLD_LIMITS, useFactory: readHouseholdLimits },
  ],
  exports: [HouseholdMemberGuard],
})
export class HouseholdModule {}
