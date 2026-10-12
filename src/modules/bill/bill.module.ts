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
import { StorageModule } from '../storage/storage.module';
import { DraftCleanupService } from './draft-cleanup.service';
import {
  DRAFT_RETENTION_DAYS,
  readDraftRetentionDays,
} from './draft-cleanup.env';
import { BILL_ITEM_TOLERANCE, readBillItemTolerance } from './bill-totals';

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
    StorageModule,
  ],
  controllers: [BillController],
  providers: [
    BillParserTask,
    BillParseCategorizeTask,
    BillAiOrchestrator,
    BillPhotoService,
    BillCrudService,
    BillDashboardService,
    DraftCleanupService,
    { provide: DRAFT_RETENTION_DAYS, useFactory: readDraftRetentionDays },
    { provide: BILL_ITEM_TOLERANCE, useFactory: readBillItemTolerance },
  ],
  exports: [BillAiOrchestrator],
})
export class BillModule {}
