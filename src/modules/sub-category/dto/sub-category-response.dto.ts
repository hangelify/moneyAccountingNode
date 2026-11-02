import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubCategoryResponseDto {
  @ApiProperty({
    description: 'Sub-category unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'Sub-category name',
    example: 'Groceries',
  })
  name!: string;

  @ApiPropertyOptional({
    description: 'Sub-category description',
    example: 'Weekly grocery shopping expenses',
  })
  description?: string;

  @ApiProperty({
    description: 'Category ID this sub-category belongs to',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  category_id!: string;

  @ApiProperty({
    description: 'Category name this sub-category belongs to',
    example: 'Food',
  })
  category_name!: string;

  @ApiProperty({
    description: 'Sub-category creation date',
    example: '2025-01-01T00:00:00.000Z',
    type: Date,
  })
  created_at!: Date;

  @ApiProperty({
    description: 'Sub-category last update date',
    example: '2025-01-01T00:00:00.000Z',
    type: Date,
  })
  updated_at!: Date;
}
