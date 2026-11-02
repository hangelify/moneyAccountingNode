import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Base DTO for category responses (without sub-categories)
 * Used for list operations and as base for extended responses
 */
export class CategoryBaseResponseDto {
  @ApiProperty({
    description: 'Category unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'Category name',
    example: 'Food & Dining',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Category description',
    example: 'Expenses related to food and dining',
  })
  description?: string;

  @ApiProperty({
    description: 'Category creation date',
    example: '2025-01-01T00:00:00.000Z',
    type: Date,
  })
  created_at!: Date;

  @ApiProperty({
    description: 'Category last update date',
    example: '2025-01-01T00:00:00.000Z',
    type: Date,
  })
  updated_at!: Date;
}
