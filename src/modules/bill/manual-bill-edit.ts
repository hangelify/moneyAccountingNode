import { BadRequestException } from '@nestjs/common';
import { Bill } from '../../entities/bill.entity';
import { BillSubCategory } from '../../entities/bill-sub-category.entity';
import { BillSource } from '../../types/bill-source.enum';
import {
  assignLineCategory,
  lineCategoryOf,
  type LineCategories,
} from './bill-lines';
import { isAmountMismatch } from './bill-totals';
import { UpdateBillDto } from './dto/update-bill.dto';

/**
 * Rules of a manual bill edit (HAN-49). A manual bill is typed in as one
 * amount: its only line follows the total, the shortcut fields of
 * `UpdateBillDto` edit that line, and an edit never leaves the total apart
 * from its lines. Bills read from a photo or a bank keep the plain update.
 */

const toCents = (v: number | string): number => Math.round(Number(v) * 100);

/** True when the update names a field that edits the bill's only line. */
export function hasLineShortcut(dto: UpdateBillDto): boolean {
  return (
    dto.category_id !== undefined ||
    dto.sub_category_id !== undefined ||
    dto.note !== undefined
  );
}

/** Throws 400 unless the shortcut fields can edit this bill's only line. */
export function checkLineShortcut(bill: Bill, lines: BillSubCategory[]): void {
  if (bill.source !== BillSource.MANUAL) {
    throw new BadRequestException(
      'category_id, sub_category_id and note edit a manual bill only; send items',
    );
  }
  if (lines.length !== 1) {
    throw new BadRequestException(
      'category_id, sub_category_id and note edit a bill with one line only; send items',
    );
  }
}

/**
 * Applies the shortcut fields to `line`. `found` holds what the fields name
 * (loaded with `findLineCategories`, which rejects a sub-category outside
 * `category_id`).
 */
export function applyLineShortcut(
  line: BillSubCategory,
  dto: UpdateBillDto,
  found: LineCategories,
): void {
  const before = `${line.sub_category?.id ?? ''}/${line.category?.id ?? ''}`;
  const { subCat, category } = lineCategoryOf(
    { sub_category_id: dto.sub_category_id, category_id: dto.category_id },
    found,
  );
  if (subCat) {
    assignLineCategory(line, subCat);
  } else if (dto.sub_category_id === null) {
    assignLineCategory(line, null, category ?? line.category ?? null);
  } else if (category && line.category?.id !== category.id) {
    // A sub-category of the old category cannot stay.
    assignLineCategory(line, null, category);
  }
  if (`${line.sub_category?.id ?? ''}/${line.category?.id ?? ''}` !== before) {
    // The model's confidence and reasoning were about the old category.
    line.category_confidence = null;
    line.category_reasoning = null;
  }
  if (dto.note !== undefined) line.raw_name = dto.note;
}

/**
 * Keeps a manual bill's total and lines in step after an update; a no-op
 * on other bills. Throws 400 when the update sets both and they disagree.
 */
export function syncManualTotal(
  bill: Bill,
  lines: BillSubCategory[],
  dto: UpdateBillDto,
  tolerance: number,
): void {
  if (bill.source !== BillSource.MANUAL) return;
  const [only] = lines;
  if (!dto.items && only && lines.length === 1) {
    if (dto.total_amount !== undefined) {
      only.amount = dto.total_amount;
      // The unit price was for the old amount.
      only.price_per_unit = null;
    }
    return;
  }
  if (dto.items && dto.total_amount === undefined) {
    bill.amount = lines.reduce((sum, l) => sum + toCents(l.amount), 0) / 100;
    return;
  }
  if (
    (dto.items || dto.total_amount !== undefined) &&
    isAmountMismatch(
      bill.amount,
      lines.map((l) => l.amount),
      tolerance,
    )
  ) {
    throw new BadRequestException(
      'total_amount must equal the sum of the item amounts on a manual bill',
    );
  }
}
