import {
  IsDefined,
  IsEnum,
  IsInt,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';

export class BillDashboardQueryDto {
  @ApiProperty({ enum: ['month', 'quarter', 'year'] })
  @IsEnum(['month', 'quarter', 'year'])
  type!: 'month' | 'quarter' | 'year';

  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year!: number;

  @ApiPropertyOptional({
    example: 4,
    description: 'Required when type=month. 1–12',
  })
  @Type(() => Number)
  @ValidateIf((o: BillDashboardQueryDto) => o.type === 'month')
  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({
    example: 2,
    description: 'Required when type=quarter. 1–4',
  })
  @Type(() => Number)
  @ValidateIf((o: BillDashboardQueryDto) => o.type === 'quarter')
  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(4)
  quarter?: number;
}

export class DashboardPeriodTotalDto {
  @ApiProperty({
    example: '2026-04-15',
    description: '"YYYY-MM-DD" for month view, "YYYY-MM" for quarter/year',
  })
  period!: string;

  @ApiProperty({ example: 1192.21 })
  total!: number;
}

export class DashboardBillSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '2026-04-15', description: 'ISO date YYYY-MM-DD' })
  bill_date!: string;

  @ApiProperty({ example: 1192.21 })
  total_amount!: number;

  @ApiProperty({ enum: Currency, nullable: true })
  currency!: Currency | null;

  @ApiProperty({ nullable: true, example: 'Nr.1 SUPERMARKET' })
  market_name!: string | null;

  @ApiProperty({
    example: 25,
    description: 'Count of bill_sub_categories rows (merged category slots)',
  })
  items_count!: number;
}

export class DashboardCategoryStatDto {
  @ApiProperty({ format: 'uuid' })
  category_id!: string;

  @ApiProperty({ example: 'Dairy' })
  category_name!: string;

  @ApiProperty({ example: 450.0 })
  total_amount!: number;

  @ApiProperty({
    example: 37.7,
    description: 'Share of the categorized spend in the same currency, 0–100',
  })
  percentage!: number;
}

export class DashboardCurrencySeriesDto {
  @ApiProperty({
    enum: Currency,
    nullable: true,
    description:
      'Currency of the bills in this series; null groups bills without a currency',
  })
  currency!: Currency | null;

  @ApiProperty({
    type: [DashboardPeriodTotalDto],
    description: 'Every period of the range, zero-filled',
  })
  period_totals!: DashboardPeriodTotalDto[];

  @ApiProperty({ type: [DashboardCategoryStatDto] })
  category_stats!: DashboardCategoryStatDto[];
}

export class BillDashboardResponseDto {
  @ApiProperty({
    type: [DashboardCurrencySeriesDto],
    description:
      'One series per currency found in the range, never summed across currencies. ' +
      'Sorted by currency code, the null series (bills without a currency) last; ' +
      'empty when the range has no bills.',
  })
  by_currency!: DashboardCurrencySeriesDto[];

  @ApiProperty({
    type: [DashboardBillSummaryDto],
    description: 'Capped at 50 most recent',
  })
  bills!: DashboardBillSummaryDto[];
}
