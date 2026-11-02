import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateBudgetDto {
  @ApiPropertyOptional({
    description: 'Budget name',
    example: 'Monthly Budget 2025',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'Budget description',
    example: 'Monthly budget for household expenses',
  })
  @IsString()
  @IsOptional()
  description?: string;
}
