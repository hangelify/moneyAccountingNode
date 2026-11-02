import {
  IsString,
  IsOptional,
  IsUUID,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCategoryDto {
  @ApiProperty({
    description: 'Category name',
    example: 'Food & Dining',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    description: 'Category description',
    example: 'Expenses related to food and dining',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Planning horizon ID to link this category to',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  planing_horizon_id!: string;
}
