import {
  IsString,
  IsOptional,
  IsUUID,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSubCategoryDto {
  @ApiProperty({
    description: 'Sub-category name',
    example: 'Groceries',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    description: 'Sub-category description',
    example: 'Weekly grocery shopping expenses',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Category ID to link this sub-category to',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  category_id!: string;
}
