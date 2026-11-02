import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { HouseholdInvite } from '../../entities/household-invite.entity';
import { HouseholdService } from './household.service';
import { HouseholdController } from './household.controller';
import { HouseholdMemberGuard } from './guards/household-member.guard';
import {
  MAX_ACTIVE_INVITES,
  readMaxActiveInvites,
} from './household-invites.env';

@Module({
  imports: [
    MikroOrmModule.forFeature([Household, HouseholdMember, HouseholdInvite]),
  ],
  controllers: [HouseholdController],
  providers: [
    HouseholdService,
    HouseholdMemberGuard,
    { provide: MAX_ACTIVE_INVITES, useFactory: readMaxActiveInvites },
  ],
  exports: [HouseholdMemberGuard],
})
export class HouseholdModule {}
