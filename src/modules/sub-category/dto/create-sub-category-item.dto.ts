import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSubCategoryItemDto {
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
}
