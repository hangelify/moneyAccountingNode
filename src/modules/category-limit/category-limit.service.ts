import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { EntityManager, FilterQuery } from '@mikro-orm/core';
import { CategoryLimit } from '../../entities/category-limit.entity';
import { decimalToNumber } from '../../common/utils/money.util';
import { todayIsoDate } from '../../common/utils/calendar-date';
import {
  CategoryLimitChange,
  WriteCategoryLimitOptions,
  writeCategoryLimit,
} from './category-limit-write';
import {
  CategoryLimitDto,
  CreateCategoryLimitDto,
  UpdateCategoryLimitDto,
} from './dto/category-limit.dto';

const toDto = (row: CategoryLimit): CategoryLimitDto => ({
  id: row.id,
  category_id: row.category.id,
  category_name: row.category.name,
  category_archived: row.category.deleted_at != null,
  period_type: row.period_type,
  amount: decimalToNumber(row.amount),
  currency: row.currency,
  effective_from: row.effective_from,
  effective_to: row.effective_to,
});

/** Versioned per-category spending limits of a household. */
@Injectable()
export class CategoryLimitService {
  constructor(private readonly em: EntityManager) {}

  /**
   * Without history: the versions in force today, at most one per category,
   * by category name. With history: every version, by category and start.
   */
  async list(
    householdId: string,
    includeHistory: boolean,
    now: Date = new Date(),
  ): Promise<CategoryLimitDto[]> {
    const today = todayIsoDate(now);
    const where: FilterQuery<CategoryLimit> = includeHistory
      ? { household: householdId }
      : {
          household: householdId,
          effective_from: { $lte: today },
          $or: [{ effective_to: null }, { effective_to: { $gt: today } }],
        };
    const rows = await this.em.fork().find(CategoryLimit, where, {
      populate: ['category'],
      orderBy: includeHistory
        ? { category: { id: 'asc' }, effective_from: 'asc' }
        : { category: { name: 'asc', id: 'asc' } },
    });
    return rows.map(toDto);
  }

  /** A limit for a category with no open one; 409 if it has one. */
  create(
    householdId: string,
    userId: string,
    dto: CreateCategoryLimitDto,
    now: Date = new Date(),
  ): Promise<CategoryLimitDto> {
    return this.write(
      householdId,
      dto.category_id,
      { kind: 'set', period_type: dto.period_type, amount: dto.amount },
      { userId, today: todayIsoDate(now), forbidOpen: true },
    );
  }

  /** Replaces the open limit from the start of the new type's period. */
  // eslint-disable-next-line max-params -- сигнатура задана планом HAN-24; `now` подменяют тесты
  update(
    householdId: string,
    userId: string,
    categoryId: string,
    dto: UpdateCategoryLimitDto,
    now: Date = new Date(),
  ): Promise<CategoryLimitDto> {
    return this.write(
      householdId,
      categoryId,
      { kind: 'set', period_type: dto.period_type, amount: dto.amount },
      { userId, today: todayIsoDate(now), requireOpen: true },
    );
  }

  /** Closes the open limit at the end of its current period; returns it. */
  remove(
    householdId: string,
    categoryId: string,
    now: Date = new Date(),
  ): Promise<CategoryLimitDto> {
    return this.write(
      householdId,
      categoryId,
      { kind: 'remove' },
      { userId: null, today: todayIsoDate(now), requireOpen: true },
    );
  }

  private write(
    householdId: string,
    categoryId: string,
    change: CategoryLimitChange,
    opts: WriteCategoryLimitOptions,
  ): Promise<CategoryLimitDto> {
    return this.em.fork().transactional(async (tx) => {
      const row = await writeCategoryLimit(
        tx,
        householdId,
        categoryId,
        change,
        opts,
      );
      // An open version exists after every write the options allow.
      if (!row) {
        throw new InternalServerErrorException(
          `No limit in force for category ${categoryId} after the write`,
        );
      }
      return toDto(row);
    });
  }
}
