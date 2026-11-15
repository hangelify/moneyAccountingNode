import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Category } from '../../entities/category.entity';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { CategoryLimit } from '../../entities/category-limit.entity';
import { CategoryLimitController } from './category-limit.controller';
import { CategoryLimitService } from './category-limit.service';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      CategoryLimit,
      Category,
      Household,
      HouseholdMember,
    ]),
  ],
  controllers: [CategoryLimitController],
  providers: [CategoryLimitService],
  exports: [CategoryLimitService],
})
export class CategoryLimitModule {}
