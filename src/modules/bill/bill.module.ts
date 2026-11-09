import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Bill } from '../../entities/bill.entity';
import { BillDuplicateDismissal } from '../../entities/bill-duplicate-dismissal.entity';
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
import { BillPhotoIngestService } from './bill-photo-ingest.service';
import { BillCrudService } from './bill-crud.service';
import { ManualBillBatchService } from './manual-bill-batch.service';
import { BillDuplicatesService } from './bill-duplicates.service';
import { BillDashboardService } from './bill-dashboard.service';
import { SpendingBreakdownService } from './spending-breakdown.service';
import { BillController } from './bill.controller';
import { StorageModule } from '../storage/storage.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { BillConversionService } from './household-conversion';
import { DraftCleanupService } from './draft-cleanup.service';
import {
  DRAFT_RETENTION_DAYS,
  readDraftRetentionDays,
} from './draft-cleanup.env';
import { MarketModule } from '../market/market.module';
import { BILL_ITEM_TOLERANCE, readBillItemTolerance } from './bill-totals';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      Bill,
      BillDuplicateDismissal,
      BillSubCategory,
      Market,
      User,
      Category,
      SubCategory,
      Household,
      HouseholdMember,
    ]),
    StorageModule,
    ExchangeRateModule,
    MarketModule,
  ],
  controllers: [BillController],
  providers: [
    BillParserTask,
    BillParseCategorizeTask,
    BillAiOrchestrator,
    BillPhotoService,
    BillPhotoIngestService,
    BillCrudService,
    ManualBillBatchService,
    BillDashboardService,
    BillDuplicatesService,
    SpendingBreakdownService,
    BillConversionService,
    DraftCleanupService,
    { provide: DRAFT_RETENTION_DAYS, useFactory: readDraftRetentionDays },
    { provide: BILL_ITEM_TOLERANCE, useFactory: readBillItemTolerance },
  ],
  // Batch parsing (BillBatchModule) reuses the bill writes and the ingest core.
  exports: [BillAiOrchestrator, BillCrudService, BillPhotoIngestService],
})
export class BillModule {}
