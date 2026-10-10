import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Category } from '../../entities/category.entity';
import { PlaningHorizon } from '../../entities/planing-horizon.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';
import { CategoryDefaultsService } from './category-defaults.service';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      Category,
      PlaningHorizon,
      SubCategory,
      Household,
      HouseholdMember,
    ]),
  ],
  controllers: [CategoryController],
  providers: [CategoryService, CategoryDefaultsService],
  exports: [CategoryService, CategoryDefaultsService],
})
export class CategoryModule {}
