import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { Category } from '../../entities/category.entity';
import { Market } from '../../entities/market.entity';
import { SubCategory } from '../../entities/sub-category.entity';
import { isAmountMismatch } from './bill-totals';
import { BillMarketRefDto, BillResponseDto } from './dto/bill-response.dto';

/** Bill line and bill response helpers shared by the bill writers. */

export function numberOrNull(
  v: number | string | null | undefined,
): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** The household's sub-categories and categories the items of a write name. */
export interface LineCategories {
  subCats: Map<string, SubCategory>;
  categories: Map<string, Category>;
}

/** The sub-category and the category an item names, from `found`. */
export function lineCategoryOf(
  item: { sub_category_id?: string | null; category_id?: string },
  found: LineCategories,
): { subCat: SubCategory | null; category: Category | null } {
  return {
    subCat: item.sub_category_id
      ? found.subCats.get(item.sub_category_id)!
      : null,
    category: item.category_id ? found.categories.get(item.category_id)! : null,
  };
}

/**
 * Sets the line's sub-category and, with it, the line's category: the
 * column must stay the sub-category's category. Without a sub-category the
 * line takes `category`, or none. `subCat` needs its category loaded.
 */
export function assignLineCategory(
  bsc: BillSubCategory,
  subCat: SubCategory | null,
  category: Category | null = null,
): void {
  bsc.sub_category = subCat;
  bsc.category = subCat?.category ?? category;
}

/** The line's own category, as answered; `category` needs its name loaded. */
export function toCategoryRef(category: Category | null | undefined) {
  return category ? { id: category.id, name: category.name } : null;
}

export function toMarketRef(market?: Market): BillMarketRefDto | undefined {
  if (!market) return undefined;
  return { id: market.id, name: market.name, city: market.city };
}

/** A saved bill as the bill list answers it, without conversion. */
export function toBillResponse(
  bill: Bill,
  items: BillSubCategory[],
  itemTolerance: number,
): BillResponseDto {
  return {
    id: bill.id,
    bill_date: bill.bill_date,
    currency: bill.currency,
    total_amount: Number(bill.amount),
    amount_mismatch: isAmountMismatch(
      bill.amount,
      items.map((i) => i.amount),
      itemTolerance,
    ),
    description: bill.description,
    source: bill.source,
    market: toMarketRef(bill.market),
    created_at: bill.created_at,
  };
}
