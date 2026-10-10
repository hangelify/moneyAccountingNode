import { toProviderJsonSchema } from '../../../ai-gateway/internal/provider-json-schema';
import { ParsedBillSchema } from './parsed-bill.schema';
import { ParsedAndCategorizedBillSchema } from './parsed-and-categorized-bill.schema';
import { Currency } from '../../../../types/currency.enum';

const item = {
  name: 'BREAD',
  quantity: 1,
  unit: 'piece',
  weight_kg: null,
  price_per_kg: null,
  final_price: 1.2,
};

const bill = {
  market_name: 'Lidl',
  bill_date: '2026-05-07',
  currency: 'EUR',
  total_amount: 23.45,
  items: [item],
  raw_extracted_text: '...',
};

const categorizedItem = {
  ...item,
  sub_category_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  category_confidence: 0.9,
  category_reasoning: 'Bread.',
};

describe('ParsedBillSchema', () => {
  it('accepts a realistic receipt shape', () => {
    const r = ParsedBillSchema.parse({
      ...bill,
      items: [
        item,
        {
          name: 'TOMATOES',
          quantity: null,
          unit: 'kg',
          weight_kg: 1.234,
          price_per_kg: 8.99,
          final_price: 11.09,
        },
      ],
    });
    expect(r.items).toHaveLength(2);
    expect(r.currency).toBe(Currency.EUR);
    expect(r.bill_date).toBe('2026-05-07');
  });

  describe('currency', () => {
    it.each([
      ['eur', Currency.EUR],
      [' ron ', Currency.RON],
    ])('normalizes %p to %p', (raw, expected) => {
      expect(ParsedBillSchema.parse({ ...bill, currency: raw }).currency).toBe(
        expected,
      );
    });

    it.each(['LEI', 'AUD', 'EURO', '', 42])(
      'falls back to null for %p instead of rejecting the response',
      (raw) => {
        expect(
          ParsedBillSchema.parse({ ...bill, currency: raw }).currency,
        ).toBeNull();
      },
    );
  });

  it.each(['07.05.2026', '2026-02-30', 'yesterday'])(
    'falls back to null for bill_date %p',
    (raw) => {
      expect(
        ParsedBillSchema.parse({ ...bill, bill_date: raw }).bill_date,
      ).toBeNull();
    },
  );

  it('truncates an item name to the 255 chars raw_name holds', () => {
    const r = ParsedBillSchema.parse({
      ...bill,
      items: [{ ...item, name: 'x'.repeat(300) }],
    });
    expect(r.items[0].name).toBe('x'.repeat(255));
  });

  it.each([
    ['quantity', 1e12],
    ['quantity', 1.5],
    ['quantity', -1],
    ['weight_kg', 1e7],
    ['price_per_kg', 1e8],
  ])('falls back to null for an out-of-range %s = %p', (field, value) => {
    const r = ParsedBillSchema.parse({
      ...bill,
      items: [{ ...item, [field]: value }],
    });
    expect(r.items[0][field as keyof typeof item]).toBeNull();
  });

  it('falls back to null for an out-of-range total_amount', () => {
    expect(
      ParsedBillSchema.parse({ ...bill, total_amount: 1e20 }).total_amount,
    ).toBeNull();
  });

  it('keeps a negative line total (discount lines)', () => {
    const r = ParsedBillSchema.parse({
      ...bill,
      items: [{ ...item, final_price: -1.5 }],
    });
    expect(r.items[0].final_price).toBe(-1.5);
  });

  it('rejects a final_price beyond the amount column', () => {
    expect(
      ParsedBillSchema.safeParse({
        ...bill,
        items: [{ ...item, final_price: 1e20 }],
      }).success,
    ).toBe(false);
  });

  it('normalizes the unit case and drops an unknown unit', () => {
    const r = ParsedBillSchema.parse({
      ...bill,
      items: [
        { ...item, unit: 'KG' },
        { ...item, unit: 'buc' },
      ],
    });
    expect(r.items.map((i) => i.unit)).toEqual(['kg', null]);
  });
});

describe('ParsedAndCategorizedBillSchema', () => {
  it('accepts a categorized receipt', () => {
    const r = ParsedAndCategorizedBillSchema.parse({
      ...bill,
      items: [categorizedItem],
    });
    expect(r.items[0]).toEqual(categorizedItem);
  });

  it('nulls doubtful categorization fields instead of failing the response', () => {
    const r = ParsedAndCategorizedBillSchema.parse({
      ...bill,
      items: [
        {
          ...categorizedItem,
          sub_category_id: 'not-a-uuid',
          category_confidence: 1.7,
          category_reasoning: 42,
        },
      ],
    });
    expect(r.items[0]).toMatchObject({
      sub_category_id: null,
      category_confidence: null,
      category_reasoning: null,
    });
  });
});

// The provider's JSON Schema is compiled from these zod schemas.
describe.each([
  ['ParsedBillSchema', ParsedBillSchema],
  ['ParsedAndCategorizedBillSchema', ParsedAndCategorizedBillSchema],
])('%s as JSON Schema', (_name, schema) => {
  it('compiles and keeps the currency enum', () => {
    const json = toProviderJsonSchema(schema) as {
      properties: { currency: { anyOf: { enum?: string[] }[] } };
    };
    const currencies = json.properties.currency.anyOf.find((s) => s.enum);
    expect(currencies?.enum).toEqual(Object.values(Currency));
  });
});
