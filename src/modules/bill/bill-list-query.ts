import { BadRequestException } from '@nestjs/common';
import { BillSource } from '../../types/bill-source.enum';
import { BillStatus } from '../../types/bill-status.enum';
import { Currency } from '../../types/currency.enum';
import type { BillListItemDto } from './dto/bill-response.dto';
import type { PaginationMetaDto } from './dto/bill-list-response.dto';
import type { ListBillsQueryDto } from './dto/list-bills-query.dto';
import { numberOrNull } from './bill-lines';

// The filters and row shape shared by the confirmed-bill lists: GET /bills
// and GET /bills/by-category/:categoryId (HAN-149).

/** `WHERE` of a confirmed-bill list over `bills b` and `markets m`. */
export interface ListWhere {
  where: string;
  params: unknown[];
}

/** Conditions of the list filters; 400 when `date_from` is after `date_to`. */
export function listWhere(
  householdId: string,
  filters: ListBillsQueryDto,
): ListWhere {
  if (
    filters.date_from &&
    filters.date_to &&
    filters.date_from > filters.date_to
  ) {
    throw new BadRequestException('date_from must not be later than date_to');
  }

  const conditions: string[] = [
    `b.household_id = ?`,
    filters.include_duplicates
      ? `b.status IN ('confirmed', 'duplicate')`
      : `b.status     = 'confirmed'`,
    `b.deleted_at IS NULL`,
  ];
  const params: unknown[] = [householdId];

  if (filters.date_from) {
    conditions.push(`b.bill_date >= ?`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push(`b.bill_date <= ?`);
    params.push(filters.date_to);
  }
  if (filters.market_names?.length) {
    conditions.push(`m.name = ANY(?)`);
    params.push(filters.market_names);
  }
  if (filters.currency) {
    conditions.push(`b.currency = ?`);
    params.push(filters.currency);
  }
  if (filters.source?.length) {
    // One placeholder per value: knex would expand an array bound to ANY(?).
    conditions.push(
      `b.source IN (${filters.source.map(() => '?').join(', ')})`,
    );
    params.push(...filters.source);
  }
  for (const bound of filters.amount_range ?? []) {
    const match = /^(gt|lt)_(\d+(?:\.\d+)?)$/.exec(bound);
    if (!match) continue;
    const [, op, val] = match;
    if (op === 'gt') {
      conditions.push(`b.amount > ?`);
    } else {
      conditions.push(`b.amount < ?`);
    }
    params.push(Number(val));
  }

  return { where: conditions.join(' AND '), params };
}

/** Page and offset of the list filters, with the defaults. */
export function listPage(filters: ListBillsQueryDto): {
  page: number;
  limit: number;
  offset: number;
} {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * Columns of a list row; the query joins `householdConversionJoin('b')`,
 * `markets m` and the per-bill line totals `i`.
 */
export const LIST_COLUMNS = `b.id, b.bill_date::text, b.currency, b.amount::text, b.description,
                b.status, b.source, b.duplicate_of_id, b.created_at::text,
                m.id AS market_id, m.name AS market_name, m.city AS market_city,
                abs(b.amount - i.total) > ? * i.count AS amount_mismatch,
                h.currency AS household_currency,
                ROUND(b.amount * fx.factor, 2)::text AS household_amount`;

/** A row of `LIST_COLUMNS`. */
export interface ListRow {
  id: string;
  bill_date: string;
  currency: Currency | null;
  amount: string;
  description: string | null;
  status: BillStatus;
  source: BillSource;
  duplicate_of_id: string | null;
  market_id: string | null;
  market_name: string | null;
  market_city: string | null;
  created_at: string;
  amount_mismatch: boolean;
  household_currency: Currency;
  household_amount: string | null;
}

export function toListItem(r: ListRow): BillListItemDto {
  return {
    id: r.id,
    bill_date: r.bill_date,
    currency: r.currency ?? undefined,
    total_amount: Number(r.amount),
    amount_mismatch: r.amount_mismatch,
    description: r.description ?? undefined,
    status: r.status,
    source: r.source,
    duplicate_of_id: r.duplicate_of_id,
    // markets.name is NOT NULL: a joined market always has one.
    market:
      r.market_id && r.market_name !== null
        ? {
            id: r.market_id,
            name: r.market_name,
            city: r.market_city ?? undefined,
          }
        : undefined,
    created_at: new Date(r.created_at),
    household_currency: r.household_currency,
    household_amount: numberOrNull(r.household_amount),
  };
}

export function pageMeta(
  total: number,
  page: number,
  limit: number,
): PaginationMetaDto {
  return { total, page, limit, total_pages: Math.ceil(total / limit) };
}
