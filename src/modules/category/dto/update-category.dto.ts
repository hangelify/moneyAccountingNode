import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateCategoryDto {
  @ApiPropertyOptional({
    description: 'Category name',
    example: 'Food & Dining',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: 'Category description',
    example: 'Expenses related to food and dining',
  })
  @IsString()
  @IsOptional()
  description?: string;
}
