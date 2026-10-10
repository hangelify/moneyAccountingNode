import { Injectable } from '@nestjs/common';
import { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import type { AiTaskResult } from '../ai-gateway/types/ai-task';
import { BillParserTask } from './tasks/bill-parser.task';
import { BillParseCategorizeTask } from './tasks/bill-parse-categorize.task';
import { ParsedBill } from './tasks/schemas/parsed-bill.schema';
import { ParsedAndCategorizedBill } from './tasks/schemas/parsed-and-categorized-bill.schema';

export interface SubCategoryInfo {
  id: string;
  category_name: string;
  sub_category_name: string;
}

@Injectable()
export class BillAiOrchestrator {
  constructor(
    private readonly gateway: AiGatewayService,
    private readonly parser: BillParserTask,
    private readonly parseCategorize: BillParseCategorizeTask,
  ) {}

  async parseAndCategorize(
    image: Buffer,
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp',
    userId: string,
    subcategories: SubCategoryInfo[],
  ): Promise<AiTaskResult<ParsedAndCategorizedBill>> {
    return this.gateway.run(
      this.parseCategorize,
      { image, mediaType, subcategories },
      { userId },
    );
  }

  async parseOnly(
    image: Buffer,
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp',
    userId: string,
  ): Promise<AiTaskResult<ParsedBill>> {
    return this.gateway.run(this.parser, { image, mediaType }, { userId });
  }
}
