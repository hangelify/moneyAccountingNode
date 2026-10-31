import type { Currency } from '../../types/currency.enum';
import type {
  SpendingCategoryDto,
  SpendingCurrencyDto,
} from './dto/spending-breakdown.dto';

/** Name of the bucket for lines without a sub-category; the client translates it. */
export const UNCATEGORIZED_NAME = 'Uncategorized';

/** One aggregated row of the spending-breakdown query. */
export interface SpendingRow {
  currency: Currency | null;
  sub_category_id: string | null;
  total: string;
  lines: string;
  sub_name: string | null;
  category_id: string | null;
  category_name: string | null;
  category_archived: boolean;
  /** The sub-category or its category is deleted. */
  archived: boolean;
}

const toCents = (v: string) => Math.round(Number(v) * 100);
const fromCents = (c: number) => c / 100;
const percent = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((part / whole) * 10000) / 100;
const byTotalThenName = (
  a: { cents: number; name: string },
  b: { cents: number; name: string },
) => b.cents - a.cents || a.name.localeCompare(b.name);

interface SubAcc {
  id: string;
  name: string;
  cents: number;
  lines: number;
  archived: boolean;
}
interface CategoryAcc {
  id: string | null;
  name: string;
  cents: number;
  lines: number;
  archived: boolean;
  subs: Map<string, SubAcc>;
}

/**
 * Folds the per (currency, sub-category) rows into one category → sub-category
 * tree per currency. Sums run in integer cents; currencies are never mixed.
 */
export function foldSpendingRows(rows: SpendingRow[]): SpendingCurrencyDto[] {
  const byCurrency = new Map<
    Currency | null,
    Map<string | null, CategoryAcc>
  >();

  for (const r of rows) {
    let categories = byCurrency.get(r.currency);
    if (!categories) {
      categories = new Map();
      byCurrency.set(r.currency, categories);
    }
    const cents = toCents(r.total);
    const lines = Number(r.lines);
    const categoryId = r.sub_category_id === null ? null : r.category_id;
    let cat = categories.get(categoryId);
    if (!cat) {
      cat =
        categoryId === null
          ? {
              id: null,
              name: UNCATEGORIZED_NAME,
              cents: 0,
              lines: 0,
              archived: false,
              subs: new Map(),
            }
          : {
              id: categoryId,
              name: r.category_name ?? '',
              cents: 0,
              lines: 0,
              archived: r.category_archived,
              subs: new Map(),
            };
      categories.set(categoryId, cat);
    }
    cat.cents += cents;
    cat.lines += lines;
    if (r.sub_category_id === null) continue;
    const sub = cat.subs.get(r.sub_category_id);
    if (sub) {
      sub.cents += cents;
      sub.lines += lines;
    } else {
      cat.subs.set(r.sub_category_id, {
        id: r.sub_category_id,
        name: r.sub_name ?? '',
        cents,
        lines,
        archived: r.archived,
      });
    }
  }

  const currencies = [...byCurrency.keys()].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0,
  );
  return currencies.map((currency) => {
    const cats = [...byCurrency.get(currency)!.values()];
    const totalCents = cats.reduce((s, c) => s + c.cents, 0);
    const lines = cats.reduce((s, c) => s + c.lines, 0);
    const categories: SpendingCategoryDto[] = cats
      .sort((a, b) =>
        a.id === null ? 1 : b.id === null ? -1 : byTotalThenName(a, b),
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        total: fromCents(c.cents),
        share: percent(c.cents, totalCents),
        archived: c.archived,
        sub_categories:
          c.id === null
            ? []
            : [...c.subs.values()].sort(byTotalThenName).map((s) => ({
                id: s.id,
                name: s.name,
                total: fromCents(s.cents),
                share_of_category: percent(s.cents, c.cents),
                lines: s.lines,
                archived: s.archived,
              })),
      }));
    return { currency, total: fromCents(totalCents), lines, categories };
  });
}
