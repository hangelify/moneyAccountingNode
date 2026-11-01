import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  DismissDuplicateDto,
  DuplicateSuggestionsQueryDto,
} from './bill-duplicates.dto';

describe('DuplicateSuggestionsQueryDto', () => {
  const toDto = (plain: Record<string, unknown>) =>
    plainToInstance(DuplicateSuggestionsQueryDto, plain);

  it('passes with no params and with valid dates', async () => {
    expect(await validate(toDto({}))).toHaveLength(0);
    expect(
      await validate(toDto({ date_from: '2026-01-01', date_to: '2026-12-31' })),
    ).toHaveLength(0);
  });

  it('fails on an invalid date', async () => {
    const errors = await validate(toDto({ date_to: '2026-13-01' }));
    expect(errors.some((e) => e.property === 'date_to')).toBe(true);
  });

  it('coerces an empty date to absent', async () => {
    const dto = toDto({ date_from: '' });
    expect(dto.date_from).toBeUndefined();
    expect(await validate(dto)).toHaveLength(0);
  });
});

describe('DismissDuplicateDto', () => {
  it('needs a uuid', async () => {
    const bad = plainToInstance(DismissDuplicateDto, { other_bill_id: 'x' });
    expect(await validate(bad)).not.toHaveLength(0);
    const ok = plainToInstance(DismissDuplicateDto, {
      other_bill_id: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(await validate(ok)).toHaveLength(0);
  });
});
