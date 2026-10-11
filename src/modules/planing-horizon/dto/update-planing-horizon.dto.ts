import {
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  MinLength,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { PeriodType } from '../../../types/period-type.enum';

export class UpdatePlaningHorizonDto {
  @ApiPropertyOptional({
    description:
      'Planning horizon name (unique per budget among active horizons, case-insensitive)',
    example: 'Q1 2025 Budget',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'Planning horizon description',
    example: 'First quarter budget for 2025',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Budget amount',
    example: 10000.5,
    minimum: 0,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsOptional()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({
    description: 'Currency',
    enum: Currency,
    example: Currency.EUR,
  })
  @IsEnum(Currency)
  @IsOptional()
  currency?: Currency;

  @ApiPropertyOptional({
    description: 'Period type',
    enum: PeriodType,
    example: PeriodType.QUARTERLY,
  })
  @IsEnum(PeriodType)
  @IsOptional()
  period_type?: PeriodType;
}
