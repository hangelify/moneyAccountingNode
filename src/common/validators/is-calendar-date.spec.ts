import { validate } from 'class-validator';
import { IsCalendarDate } from './is-calendar-date';

class Dto {
  @IsCalendarDate()
  d!: unknown;
}

const errors = async (d: unknown) => {
  const dto = new Dto();
  dto.d = d;
  return validate(dto);
};

describe('IsCalendarDate', () => {
  it('accepts a plain calendar date', async () => {
    expect(await errors('2026-05-19')).toHaveLength(0);
  });

  it.each(['2026-02-30', '2026-05-19T01:00+03:00', '2026-05-19T00:00:00Z', 5])(
    'rejects %p',
    async (v) => {
      expect(await errors(v)).toHaveLength(1);
    },
  );
});
