import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateSubCategoryDto {
  @ApiPropertyOptional({
    description: 'Sub-category name',
    example: 'Groceries',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: 'Sub-category description',
    example: 'Weekly grocery shopping expenses',
  })
  @IsString()
  @IsOptional()
  description?: string;
}
