import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MoveBillsDto } from './move-bills.dto';

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const TARGET = uuid(999999);

const errorsOf = async (body: unknown): Promise<string[]> => {
  const errors = await validate(plainToInstance(MoveBillsDto, body));
  return errors.map((e) => e.property);
};

describe('MoveBillsDto', () => {
  it('accepts 1 id', async () => {
    expect(
      await errorsOf({ bill_ids: [uuid(1)], target_household_id: TARGET }),
    ).toEqual([]);
  });

  it('accepts 100 ids', async () => {
    const bill_ids = Array.from({ length: 100 }, (_, i) => uuid(i + 1));
    expect(await errorsOf({ bill_ids, target_household_id: TARGET })).toEqual(
      [],
    );
  });

  it('rejects an empty list', async () => {
    expect(
      await errorsOf({ bill_ids: [], target_household_id: TARGET }),
    ).toEqual(['bill_ids']);
  });

  it('rejects 101 ids', async () => {
    const bill_ids = Array.from({ length: 101 }, (_, i) => uuid(i + 1));
    expect(await errorsOf({ bill_ids, target_household_id: TARGET })).toEqual([
      'bill_ids',
    ]);
  });

  it('rejects a repeated id', async () => {
    expect(
      await errorsOf({
        bill_ids: [uuid(1), uuid(1)],
        target_household_id: TARGET,
      }),
    ).toEqual(['bill_ids']);
  });

  it('rejects a non-uuid id', async () => {
    expect(
      await errorsOf({
        bill_ids: [uuid(1), 'not-a-uuid'],
        target_household_id: TARGET,
      }),
    ).toEqual(['bill_ids']);
  });

  it('rejects a missing target_household_id', async () => {
    expect(await errorsOf({ bill_ids: [uuid(1)] })).toEqual([
      'target_household_id',
    ]);
  });

  it('rejects a malformed target_household_id', async () => {
    expect(
      await errorsOf({ bill_ids: [uuid(1)], target_household_id: 'nope' }),
    ).toEqual(['target_household_id']);
  });
});
