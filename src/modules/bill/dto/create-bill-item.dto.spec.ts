import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateBillItemDto } from './create-bill.dto';

async function errorProps(item: object) {
  const errors = await validate(
    plainToInstance(CreateBillItemDto, {
      product_count: 1,
      amount: 2,
      ...item,
    }),
  );
  return errors.map((e) => e.property);
}

// A line names its sub-category, its category, or both (HAN-95).
describe('CreateBillItemDto category', () => {
  it.each([
    ['a sub-category', { sub_category_id: randomUUID() }],
    ['a category', { category_id: randomUUID() }],
    ['both', { sub_category_id: randomUUID(), category_id: randomUUID() }],
    [
      'a category and a null sub-category',
      { sub_category_id: null, category_id: randomUUID() },
    ],
  ])('accepts %s', async (_, item) => {
    expect(await errorProps(item)).toEqual([]);
  });

  it.each([
    ['neither', {}],
    ['both null', { sub_category_id: null, category_id: null }],
  ])('rejects %s', async (_, item) => {
    expect(await errorProps(item)).toEqual(['sub_category_id']);
  });

  it.each([
    ['sub_category_id', { sub_category_id: 'nope' }],
    ['category_id', { category_id: 'nope', sub_category_id: randomUUID() }],
  ])('rejects a bad %s', async (prop, item) => {
    expect(await errorProps(item)).toContain(prop);
  });
});
