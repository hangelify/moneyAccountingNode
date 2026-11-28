import type { Connection } from '@mikro-orm/core';
import { Currency } from '../../types/currency.enum';
import { LIST_COLUMNS, type ListRow, type ListWhere } from './bill-list-query';
import { householdConversionJoin } from './household-conversion';

// SQL reads of the bills of a category (HAN-149). `w` is the list WHERE,
// already narrowed to bills with a line in the category.

export interface CategoryRefRow {
  id: string;
  name: string;
  archived: boolean;
  household_currency: Currency;
}

/** The household's category, archived included; undefined when not its. */
export async function readCategoryRef(
  conn: Connection,
  householdId: string,
  categoryId: string,
): Promise<CategoryRefRow | undefined> {
  const rows = (await conn.execute(
    `SELECT c.id, c.name, (c.deleted_at IS NOT NULL) AS archived,
            h.currency AS household_currency
     FROM   categories c
     JOIN   households h ON h.id = c.household_id
     WHERE  c.id = ? AND c.household_id = ?`,
    [categoryId, householdId],
  )) as CategoryRefRow[];
  return rows[0];
}

/** `w` narrowed to bills with a line in the category. */
export function inCategory(w: ListWhere, categoryId: string): ListWhere {
  return {
    where: `${w.where}
           AND  EXISTS (SELECT 1 FROM bill_sub_categories c
                        WHERE c.bill_id = b.id AND c.category_id = ?)`,
    params: [...w.params, categoryId],
  };
}

export async function countBills(
  conn: Connection,
  w: ListWhere,
): Promise<number> {
  const rows = (await conn.execute(
    `SELECT COUNT(*) AS count
     FROM   bills b
     LEFT   JOIN markets m ON m.id = b.market_id
     WHERE  ${w.where}`,
    w.params,
  )) as { count: string }[];
  return Number(rows[0]?.count ?? 0);
}

/**
 * The category's lines over every bill of `w`, converted and rounded per
 * sub-category as `fetchSpent` of the limits report does, and the number of
 * lines without a rate (left out of the total).
 */
export async function readCategoryTotal(
  conn: Connection,
  scope: { source: string; categoryId: string },
  w: ListWhere,
): Promise<{ total: number; unconverted_lines: number }> {
  const rows = (await conn.execute(
    `SELECT COALESCE(SUM(g.total), 0)::text AS total,
            COALESCE(SUM(g.unconverted), 0)::int AS unconverted_lines
     FROM  (SELECT ROUND(SUM(l.amount * fx.factor), 2) AS total,
                   COUNT(*) FILTER (WHERE fx.factor IS NULL) AS unconverted
            FROM   bills b
            ${householdConversionJoin('b')}
            LEFT   JOIN markets m ON m.id = b.market_id
            JOIN   bill_sub_categories l
                   ON l.bill_id = b.id AND l.category_id = ?
            WHERE  ${w.where}
            GROUP  BY l.sub_category_id) g`,
    [scope.source, scope.source, scope.categoryId, ...w.params],
  )) as { total: string; unconverted_lines: number }[];
  return {
    total: Number(rows[0]?.total ?? 0),
    unconverted_lines: rows[0]?.unconverted_lines ?? 0,
  };
}

export type CategoryPageRow = ListRow & { category_amount: string | null };

/** One page of `w`, newest first, with each bill's category contribution. */
export function readCategoryPage(
  conn: Connection,
  scope: {
    source: string;
    categoryId: string;
    itemTolerance: number;
    limit: number;
    offset: number;
  },
  w: ListWhere,
): Promise<CategoryPageRow[]> {
  return conn.execute(
    `SELECT ${LIST_COLUMNS},
            ROUND(i.in_category * fx.factor, 2)::text AS category_amount
     FROM   bills b
     ${householdConversionJoin('b')}
     -- A deleted market still shows on its bills, as history.
     LEFT   JOIN markets m ON m.id = b.market_id
     CROSS  JOIN LATERAL (
              SELECT coalesce(sum(amount), 0) AS total, count(*) AS count,
                     sum(amount) FILTER (WHERE category_id = ?) AS in_category
              FROM   bill_sub_categories
              WHERE  bill_id = b.id
            ) i
     WHERE  ${w.where}
     ORDER  BY b.bill_date DESC, b.created_at DESC, b.id DESC
     LIMIT  ? OFFSET ?`,
    [
      scope.itemTolerance,
      scope.source,
      scope.source,
      scope.categoryId,
      ...w.params,
      scope.limit,
      scope.offset,
    ],
  ) as Promise<CategoryPageRow[]>;
}
