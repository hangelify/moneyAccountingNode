import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BudgetResponseDto {
  @ApiProperty({
    description: 'Budget unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'Budget name',
    example: 'Monthly Budget 2025',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Budget description',
    example: 'Monthly budget for household expenses',
  })
  description?: string;

  @ApiProperty({
    description: 'Budget creation date',
    example: '2025-01-01T00:00:00.000Z',
    type: Date,
  })
  created_at!: Date;
}
