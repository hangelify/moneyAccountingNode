import { IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { LimitPeriodType } from '../../../types/limit-period-type.enum';
import { IsCalendarDate } from '../../../common/validators/is-calendar-date';
import { UnconvertedDto } from '../../bill';
import type {
  LimitReport,
  LimitReportCategory,
  LimitReportTotal,
} from '../limit-report';

/** Query of `GET report`: the period type and any day of the period. */
export class LimitReportQueryDto {
  @ApiProperty({
    description: 'Calendar period type of the report',
    enum: LimitPeriodType,
    example: LimitPeriodType.MONTHLY,
  })
  @IsEnum(LimitPeriodType)
  period_type!: LimitPeriodType;

  @ApiPropertyOptional({
    description:
      'Any day of the period (YYYY-MM-DD); defaults to today (UTC). Future days are allowed.',
    example: '2026-11-15',
    format: 'date',
  })
  @IsOptional()
  @IsCalendarDate()
  date?: string;
}

/** One category with a limit version in force in the period. */
export class LimitReportCategoryDto implements LimitReportCategory {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  category_id!: string;

  @ApiProperty({ example: 'Food' })
  category_name!: string;

  @ApiProperty({
    description: 'True when the category is deleted (archived)',
    example: false,
  })
  category_archived!: boolean;

  @ApiProperty({
    description: 'Limit version in force in the period',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  limit_id!: string;

  @ApiProperty({ description: "Limit in the version's currency", example: 300 })
  limit_amount!: number;

  @ApiProperty({
    description: 'Currency of the version; may differ from the household one',
    enum: Currency,
    example: Currency.EUR,
  })
  limit_currency!: Currency;

  @ApiProperty({
    description:
      'limit_amount in the household currency; null when no rate is saved',
    example: 300,
    type: Number,
    nullable: true,
  })
  base_limit!: number | null;

  @ApiProperty({
    description:
      'Balance carried from the previous period: > 0 savings, < 0 debt; 0 at the chain start',
    example: -10,
  })
  carried_in!: number;

  @ApiProperty({
    description: 'base_limit + carried_in; null when base_limit is null',
    example: 290,
    type: Number,
    nullable: true,
  })
  limit!: number | null;

  @ApiProperty({
    description: 'Spent in the household currency, converted lines only',
    example: 120.5,
  })
  spent!: number;

  @ApiProperty({
    description: 'limit - spent; < 0 means overspent',
    example: 169.5,
    type: Number,
    nullable: true,
  })
  remaining!: number | null;

  @ApiProperty({
    description:
      'spent / limit * 100, 2 decimals; null when limit is null or <= 0',
    example: 41.55,
    type: Number,
    nullable: true,
  })
  percent!: number | null;

  @ApiProperty({
    description: 'False when the period is marked "do not carry over"',
    example: true,
  })
  carry_over!: boolean;

  @ApiProperty({
    description:
      'carried_in is based on incomplete data (unconverted lines or limits earlier in the chain)',
    example: false,
  })
  carry_incomplete!: boolean;

  @ApiProperty({
    description:
      'Lines of the category in the period without a rate; > 0 means spent is incomplete',
    example: 0,
  })
  unconverted_lines!: number;
}

/** Totals over the categories whose base limit could be converted. */
export class LimitReportTotalDto implements LimitReportTotal {
  @ApiProperty({ example: 300 })
  base_limit!: number;

  @ApiProperty({ example: -10 })
  carried_in!: number;

  @ApiProperty({ description: 'base_limit + carried_in', example: 290 })
  limit!: number;

  @ApiProperty({ example: 120.5 })
  spent!: number;

  @ApiProperty({ description: 'limit - spent', example: 169.5 })
  remaining!: number;

  @ApiProperty({
    description: 'null when limit <= 0',
    example: 41.55,
    type: Number,
    nullable: true,
  })
  percent!: number | null;
}

/** Spending against the category limits of one period. */
export class LimitReportDto implements LimitReport {
  @ApiProperty({ enum: LimitPeriodType, example: LimitPeriodType.MONTHLY })
  period_type!: LimitPeriodType;

  @ApiProperty({
    description: 'First day of the period (YYYY-MM-DD)',
    example: '2026-11-01',
  })
  start!: string;

  @ApiProperty({
    description: 'First day of the next period (YYYY-MM-DD), exclusive',
    example: '2026-12-01',
  })
  end!: string;

  @ApiProperty({
    description: 'Current household currency',
    enum: Currency,
    example: Currency.EUR,
  })
  currency!: Currency;

  @ApiProperty({
    type: [LimitReportCategoryDto],
    description: 'By category name, then id',
  })
  categories!: LimitReportCategoryDto[];

  @ApiProperty({ type: LimitReportTotalDto })
  total!: LimitReportTotalDto;

  @ApiProperty({
    description:
      'Spent in the period without a category or in categories with no limit of any type',
    example: 42,
  })
  other_spent!: number;

  @ApiProperty({
    type: [UnconvertedDto],
    description: 'Bills of the period without a rate, by original currency',
  })
  unconverted!: UnconvertedDto[];
}
