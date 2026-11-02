import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { PeriodType } from '../../../types/period-type.enum';

/**
 * Base DTO for planning horizon responses (without categories)
 * Used for create, update operations
 */
export class PlaningHorizonBaseResponseDto {
  @ApiProperty({
    description: 'Planning horizon unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'Planning horizon name',
    example: 'Q1 2025 Budget',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Planning horizon description',
    example: 'First quarter budget for 2025',
  })
  description?: string;

  @ApiProperty({
    description: 'Budget amount',
    example: 10000.5,
  })
  amount!: number;

  @ApiProperty({
    description: 'Currency',
    enum: Currency,
    example: Currency.EUR,
  })
  currency!: Currency;

  @ApiProperty({
    description: 'Period type',
    enum: PeriodType,
    example: PeriodType.QUARTERLY,
  })
  period_type!: PeriodType;

  @ApiProperty({
    description: 'Planning horizon creation date',
    example: '2025-01-01T00:00:00.000Z',
    type: Date,
  })
  created_at!: Date;

  @ApiProperty({
    description: 'Planning horizon last update date',
    example: '2025-01-01T00:00:00.000Z',
    type: Date,
  })
  updated_at!: Date;

  @ApiProperty({
    description: 'Whether the planning horizon is archived',
    example: false,
  })
  is_archived!: boolean;

  @ApiProperty({
    description: 'Budget ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  budget_id!: string;
}
