import { IsBoolean, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { LimitPeriodType } from '../../../types/limit-period-type.enum';
import { IsCalendarDate } from '../../../common/validators/is-calendar-date';

/** Body of `PUT :categoryId/carry-over`: mark or unmark one period. */
export class SetCarryOverDto {
  @ApiProperty({
    description: 'Period type of the limit whose period is marked',
    enum: LimitPeriodType,
    example: LimitPeriodType.MONTHLY,
  })
  @IsEnum(LimitPeriodType)
  period_type!: LimitPeriodType;

  @ApiProperty({
    description:
      'First day of the period (YYYY-MM-DD); a past or the current period',
    example: '2026-09-01',
    format: 'date',
  })
  @IsCalendarDate()
  period_start!: string;

  @ApiProperty({
    description:
      'false: do not carry the balance of the period to the next one; true: carry it (removes the mark)',
    example: false,
  })
  @IsBoolean()
  carry_over!: boolean;
}
