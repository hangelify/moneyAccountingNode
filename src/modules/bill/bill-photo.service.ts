import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { SubCategory } from '../../entities/sub-category.entity';
import { BillAiOrchestrator } from './bill-ai.orchestrator';
import type { ParsedBill } from './tasks/schemas/parsed-bill.schema';
import type { ParsedAndCategorizedBill } from './tasks/schemas/parsed-and-categorized-bill.schema';
import type {
  ParsedBillResponseDto,
  ParsedBillItemResponseDto,
} from './dto/parsed-bill-response.dto';

@Injectable()
export class BillPhotoService {
  constructor(
    private readonly orchestrator: BillAiOrchestrator,
    @InjectRepository(SubCategory)
    private readonly subCategoryRepo: EntityRepository<SubCategory>,
  ) {}

  async parseAndCategorize(
    image: Buffer,
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp',
    householdId: string,
    userId: string,
  ): Promise<{ parsed: ParsedBillResponseDto; requestId: string }> {
    const subs = await this.subCategoryRepo.find(
      { deleted_at: null, category: { household: { id: householdId } } },
      { populate: ['category'] },
    );

    if (subs.length === 0) {
      const { data, requestId } = await this.orchestrator.parseOnly(
        image,
        mediaType,
        userId,
      );
      return { parsed: this.fromParsed(data), requestId };
    }

    const byId = new Map(subs.map((s) => [s.id, s]));
    const subcategories = subs.map((s) => ({
      id: s.id,
      category_name: s.category.name,
      sub_category_name: s.name,
    }));

    const { data, requestId } = await this.orchestrator.parseAndCategorize(
      image,
      mediaType,
      userId,
      subcategories,
    );
    return { parsed: this.fromParsedAndCategorized(data, byId), requestId };
  }

  private fromParsed(parsed: ParsedBill): ParsedBillResponseDto {
    return {
      draft_id: '',
      market_name: parsed.market_name,
      bill_date: parsed.bill_date,
      currency: parsed.currency,
      total_amount: parsed.total_amount,
      raw_extracted_text: parsed.raw_extracted_text,
      items: parsed.items.map(
        (it): ParsedBillItemResponseDto => ({
          name: it.name,
          quantity: it.quantity,
          unit: it.unit,
          weight_kg: it.weight_kg,
          price_per_kg: it.price_per_kg,
          final_price: it.final_price,
          sub_category: null,
          category_confidence: 0,
        }),
      ),
    };
  }

  private fromParsedAndCategorized(
    bill: ParsedAndCategorizedBill,
    byId: Map<string, SubCategory>,
  ): ParsedBillResponseDto {
    return {
      draft_id: '',
      market_name: bill.market_name,
      bill_date: bill.bill_date,
      currency: bill.currency,
      total_amount: bill.total_amount,
      raw_extracted_text: bill.raw_extracted_text,
      items: bill.items.map((it): ParsedBillItemResponseDto => {
        const sub = it.sub_category_id
          ? byId.get(it.sub_category_id)
          : undefined;
        return {
          name: it.name,
          quantity: it.quantity,
          unit: it.unit,
          weight_kg: it.weight_kg,
          price_per_kg: it.price_per_kg,
          final_price: it.final_price,
          sub_category: sub
            ? { id: sub.id, name: sub.name, category_name: sub.category.name }
            : null,
          category_confidence: it.category_confidence ?? 0,
          category_reasoning: it.category_reasoning ?? undefined,
        };
      }),
    };
  }
}
