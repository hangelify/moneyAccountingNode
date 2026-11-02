import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCategoryItemDto {
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
}
