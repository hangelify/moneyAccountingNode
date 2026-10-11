import {
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  IsUUID,
  MinLength,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { PeriodType } from '../../../types/period-type.enum';

export class CreatePlaningHorizonDto {
  @ApiProperty({
    description:
      'Planning horizon name (unique per budget among active horizons, case-insensitive)',
    example: 'Q1 2025 Budget',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    description: 'Planning horizon description',
    example: 'First quarter budget for 2025',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Budget amount',
    example: 10000.5,
    minimum: 0,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;

  @ApiProperty({
    description: 'Currency',
    enum: Currency,
    example: Currency.EUR,
  })
  @IsEnum(Currency)
  currency!: Currency;

  @ApiProperty({
    description: 'Period type',
    enum: PeriodType,
    example: PeriodType.QUARTERLY,
  })
  @IsEnum(PeriodType)
  period_type!: PeriodType;

  @ApiProperty({
    description: 'Budget ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  budget_id!: string;
}
