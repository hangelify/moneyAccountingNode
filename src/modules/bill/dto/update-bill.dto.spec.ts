import { randomUUID } from 'node:crypto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateBillDto } from './update-bill.dto';

function errorsOn(plain: Record<string, unknown>): Promise<string[]> {
  return validate(plainToInstance(UpdateBillDto, plain)).then((errors) =>
    errors.map((e) => e.property),
  );
}

// Shortcut fields that edit the only line of a manual bill (HAN-49).
describe('UpdateBillDto line shortcut', () => {
  it('accepts category_id, sub_category_id and note', async () => {
    expect(
      await errorsOn({
        category_id: randomUUID(),
        sub_category_id: randomUUID(),
        note: 'coffee',
      }),
    ).toEqual([]);
  });

  it('accepts sub_category_id null', async () => {
    expect(await errorsOn({ sub_category_id: null })).toEqual([]);
  });

  it('rejects a non-uuid category_id', async () => {
    expect(await errorsOn({ category_id: 'food' })).toContain('category_id');
  });

  it('rejects a non-uuid sub_category_id', async () => {
    expect(await errorsOn({ sub_category_id: 'bread' })).toContain(
      'sub_category_id',
    );
  });

  it('rejects an empty note', async () => {
    expect(await errorsOn({ note: '' })).toContain('note');
  });

  it('rejects a note over 255 chars', async () => {
    expect(await errorsOn({ note: 'x'.repeat(256) })).toContain('note');
  });
});
