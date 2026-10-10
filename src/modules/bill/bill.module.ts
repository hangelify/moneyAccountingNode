import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { Market } from '../../entities/market.entity';
import { User } from '../../entities/user.entity';
import { Category } from '../../entities/category.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { BillParserTask } from './tasks/bill-parser.task';
import { BillParseCategorizeTask } from './tasks/bill-parse-categorize.task';
import { BillAiOrchestrator } from './bill-ai.orchestrator';
import { BillPhotoService } from './bill-photo.service';
import { BillCrudService } from './bill-crud.service';
import { BillDashboardService } from './bill-dashboard.service';
import { BillController } from './bill.controller';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      Bill,
      BillSubCategory,
      Market,
      User,
      Category,
      SubCategory,
      Household,
      HouseholdMember,
    ]),
  ],
  controllers: [BillController],
  providers: [
    BillParserTask,
    BillParseCategorizeTask,
    BillAiOrchestrator,
    BillPhotoService,
    BillCrudService,
    BillDashboardService,
  ],
  exports: [BillAiOrchestrator],
})
export class BillModule {}
