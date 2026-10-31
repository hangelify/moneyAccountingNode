import { Currency } from '../../types/currency.enum';
import {
  foldSpendingRows,
  SpendingRow,
  UNCATEGORIZED_NAME,
} from './spending-breakdown';

const row = (r: Partial<SpendingRow>): SpendingRow => ({
  currency: Currency.EUR,
  sub_category_id: 'sub-bread',
  total: '0',
  lines: '1',
  sub_name: 'bread',
  category_id: 'cat-food',
  category_name: 'Food',
  category_archived: false,
  archived: false,
  ...r,
});

describe('foldSpendingRows', () => {
  it('returns no series for no rows', () => {
    expect(foldSpendingRows([])).toEqual([]);
  });

  it('nests sub-categories under their category with shares', () => {
    const [eur] = foldSpendingRows([
      row({ total: '30.00', lines: '3' }),
      row({ sub_category_id: 'sub-milk', sub_name: 'milk', total: '10.00' }),
      row({
        sub_category_id: 'sub-soap',
        sub_name: 'soap',
        category_id: 'cat-home',
        category_name: 'Home',
        total: '60.00',
        lines: '2',
      }),
    ]);

    expect(eur).toEqual({
      currency: Currency.EUR,
      total: 100,
      lines: 6,
      categories: [
        {
          id: 'cat-home',
          name: 'Home',
          total: 60,
          share: 60,
          archived: false,
          sub_categories: [
            {
              id: 'sub-soap',
              name: 'soap',
              total: 60,
              share_of_category: 100,
              lines: 2,
              archived: false,
            },
          ],
        },
        {
          id: 'cat-food',
          name: 'Food',
          total: 40,
          share: 40,
          archived: false,
          sub_categories: [
            {
              id: 'sub-bread',
              name: 'bread',
              total: 30,
              share_of_category: 75,
              lines: 3,
              archived: false,
            },
            {
              id: 'sub-milk',
              name: 'milk',
              total: 10,
              share_of_category: 25,
              lines: 1,
              archived: false,
            },
          ],
        },
      ],
    });
  });

  it('puts uncategorized lines in a last bucket even when it is the largest', () => {
    const [eur] = foldSpendingRows([
      row({ total: '1.00' }),
      row({
        sub_category_id: null,
        sub_name: null,
        category_id: null,
        category_name: null,
        total: '99.00',
        lines: '4',
      }),
    ]);

    expect(eur.categories.map((c) => c.id)).toEqual(['cat-food', null]);
    expect(eur.categories[1]).toEqual({
      id: null,
      name: UNCATEGORIZED_NAME,
      total: 99,
      share: 99,
      archived: false,
      sub_categories: [],
    });
    expect(eur.lines).toBe(5);
  });

  it('keeps currencies apart, sorted by code with null last', () => {
    const series = foldSpendingRows([
      row({ currency: null, total: '5.00' }),
      row({ currency: Currency.USD, total: '7.00' }),
      row({ currency: Currency.EUR, total: '3.00' }),
    ]);

    expect(series.map((s) => [s.currency, s.total])).toEqual([
      [Currency.EUR, 3],
      [Currency.USD, 7],
      [null, 5],
    ]);
    expect(series.every((s) => s.categories[0].share === 100)).toBe(true);
  });

  it('sums in integer cents', () => {
    const [eur] = foldSpendingRows([
      row({ total: '0.10' }),
      row({ sub_category_id: 'sub-milk', sub_name: 'milk', total: '0.20' }),
    ]);
    expect(eur.total).toBe(0.3);
    expect(eur.categories[0].total).toBe(0.3);
  });

  it('rounds shares to 2 decimals', () => {
    const [eur] = foldSpendingRows([
      row({ total: '1.00' }),
      row({
        sub_category_id: 'sub-soap',
        category_id: 'cat-home',
        category_name: 'Home',
        total: '2.00',
      }),
    ]);
    expect(eur.categories.map((c) => c.share)).toEqual([66.67, 33.33]);
  });

  it('gives zero shares when the total is zero', () => {
    const [eur] = foldSpendingRows([row({ total: '0.00' })]);
    expect(eur.categories[0].share).toBe(0);
    expect(eur.categories[0].sub_categories[0].share_of_category).toBe(0);
  });

  it('breaks total ties by name', () => {
    const [eur] = foldSpendingRows([
      row({ sub_category_id: 's-b', sub_name: 'b', total: '5.00' }),
      row({ sub_category_id: 's-a', sub_name: 'a', total: '5.00' }),
    ]);
    expect(eur.categories[0].sub_categories.map((s) => s.name)).toEqual([
      'a',
      'b',
    ]);
  });

  it('marks archived categories and sub-categories separately', () => {
    const [eur] = foldSpendingRows([
      row({ archived: true, total: '1.00' }),
      row({
        sub_category_id: 'sub-old',
        sub_name: 'old',
        category_id: 'cat-old',
        category_name: 'Old',
        category_archived: true,
        archived: true,
        total: '2.00',
      }),
    ]);
    const [old, food] = eur.categories;
    expect(old.archived).toBe(true);
    expect(old.sub_categories[0].archived).toBe(true);
    expect(food.archived).toBe(false);
    expect(food.sub_categories[0].archived).toBe(true);
  });
});
