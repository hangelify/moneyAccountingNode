import {
  IsOptional,
  IsArray,
  IsString,
  IsEnum,
  MinLength,
  MaxLength,
  Matches,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { IsCalendarDate } from '../../../common/validators/is-calendar-date';

export class ListBillsQueryDto {
  @ApiPropertyOptional({
    example: '2026-01-01',
    format: 'date',
    description:
      'Include bills with bill_date >= this date (YYYY-MM-DD). Omit to start from the beginning.',
  })
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsOptional()
  @IsCalendarDate()
  date_from?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    format: 'date',
    description:
      'Include bills with bill_date <= this date (YYYY-MM-DD). Omit to include up to today.',
  })
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsOptional()
  @IsCalendarDate()
  date_to?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['Lidl', 'Kaufland'],
    description:
      'Filter by one or more market names (exact, case-sensitive). Repeat the param for multiple values: ?market_names=Lidl&market_names=Kaufland. Bills with no linked market are excluded when this filter is set.',
  })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? value : typeof value === 'string' ? [value] : value,
  )
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(255, { each: true })
  market_names?: string[];

  @ApiPropertyOptional({
    enum: Currency,
    description: 'Filter by currency (exact match).',
  })
  @IsOptional()
  @IsEnum(Currency)
  currency?: Currency;

  @ApiPropertyOptional({
    type: [String],
    example: ['gt_100', 'lt_500'],
    description:
      'Filter by amount bounds. Each value must be gt_N or lt_N where N is a positive number. ' +
      'Send both to define a range: ?amount_range=gt_100&amount_range=lt_500 means 100 < amount < 500.',
  })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? value : typeof value === 'string' ? [value] : value,
  )
  @IsOptional()
  @IsArray()
  @Matches(/^(gt|lt)_\d+(\.\d+)?$/, {
    each: true,
    message:
      'Each amount_range value must be gt_N or lt_N (e.g. gt_100, lt_500)',
  })
  amount_range?: string[];

  @ApiPropertyOptional({
    example: 1,
    description: 'Page number (1-based). Defaults to 1.',
    default: 1,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    example: 20,
    description: 'Number of results per page. Defaults to 20, max 100.',
    default: 20,
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
