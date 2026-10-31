import {
  IsDefined,
  IsEnum,
  IsIn,
  IsOptional,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { IsCalendarDate } from '../../../common/validators/is-calendar-date';
import { IsValidCustomRange } from '../../../common/validators/is-valid-custom-range';
import {
  MAX_CUSTOM_RANGE_YEARS,
  SPENDING_PERIODS,
  type SpendingPeriod,
} from '../../../common/utils/period-range';
import { UNCATEGORIZED_NAME } from '../spending-breakdown';

export class SpendingBreakdownQueryDto {
  @ApiProperty({
    enum: SPENDING_PERIODS,
    description:
      'week = ISO week (Monday start); 5y = the 60 full months ending with the ' +
      "anchor's month; custom = from..to (both inclusive)",
  })
  @IsIn(SPENDING_PERIODS)
  period!: SpendingPeriod;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description:
      'Any day inside the period, YYYY-MM-DD. Defaults to today in UTC; send ' +
      "the client's local date. Ignored for period=custom.",
  })
  @IsOptional()
  @IsCalendarDate()
  anchor?: string;

  @ApiPropertyOptional({
    example: '2026-01-01',
    description: 'First day, YYYY-MM-DD. Required when period=custom.',
  })
  @ValidateIf((o: SpendingBreakdownQueryDto) => o.period === 'custom')
  @IsDefined()
  @IsCalendarDate()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-03-31',
    description:
      `Last day (inclusive), YYYY-MM-DD. Required when period=custom; not ` +
      `before from, and at most ${MAX_CUSTOM_RANGE_YEARS} years after it.`,
  })
  @ValidateIf((o: SpendingBreakdownQueryDto) => o.period === 'custom')
  @IsDefined()
  @IsCalendarDate()
  @IsValidCustomRange('from')
  to?: string;

  @ApiPropertyOptional({
    enum: Currency,
    description: 'Only bills in this currency',
  })
  @IsOptional()
  @IsEnum(Currency)
  currency?: Currency;
}

export class SpendingRangeDto {
  @ApiProperty({ enum: SPENDING_PERIODS })
  period!: SpendingPeriod;

  @ApiProperty({ example: '2026-10-01', description: 'First day, inclusive' })
  start!: string;

  @ApiProperty({
    example: '2026-11-01',
    description: 'Day after the range, exclusive',
  })
  end!: string;
}

export class SpendingSubCategoryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Milk' })
  name!: string;

  @ApiProperty({ example: 42.5 })
  total!: number;

  @ApiProperty({
    example: 37.5,
    description: 'Share of the parent category total, 0–100, 2 decimals',
  })
  share_of_category!: number;

  @ApiProperty({ example: 7, description: 'Receipt lines counted' })
  lines!: number;

  @ApiProperty({
    description:
      'The sub-category or its category was deleted; kept for history',
  })
  archived!: boolean;
}

export class SpendingCategoryDto {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'null for the Uncategorized bucket',
  })
  id!: string | null;

  @ApiProperty({
    example: 'Dairy',
    description: `Category name, or "${UNCATEGORIZED_NAME}" for lines without a sub-category (translate it on the client)`,
  })
  name!: string;

  @ApiProperty({ example: 113.33 })
  total!: number;

  @ApiProperty({
    example: 24.1,
    description: 'Share of the currency total, 0–100, 2 decimals',
  })
  share!: number;

  @ApiProperty({ description: 'The category was deleted; kept for history' })
  archived!: boolean;

  @ApiProperty({
    type: [SpendingSubCategoryDto],
    description: 'Sorted by total, largest first; empty for Uncategorized',
  })
  sub_categories!: SpendingSubCategoryDto[];
}

export class SpendingCurrencyDto {
  @ApiProperty({
    enum: Currency,
    nullable: true,
    description: 'null groups bills without a currency',
  })
  currency!: Currency | null;

  @ApiProperty({ example: 470.2 })
  total!: number;

  @ApiProperty({ example: 58, description: 'Receipt lines counted' })
  lines!: number;

  @ApiProperty({
    type: [SpendingCategoryDto],
    description: 'Sorted by total, largest first; Uncategorized always last',
  })
  categories!: SpendingCategoryDto[];
}

export class SpendingBreakdownResponseDto {
  @ApiProperty({ type: SpendingRangeDto })
  range!: SpendingRangeDto;

  @ApiProperty({
    type: [SpendingCurrencyDto],
    description:
      'One tree per currency, never summed across currencies. Sorted by ' +
      'currency code, the null series last; empty when the range has no ' +
      'spending. Totals are sums of receipt line amounts, not of bill ' +
      'totals, so they can differ from the bill totals by a few cents.',
  })
  by_currency!: SpendingCurrencyDto[];
}
