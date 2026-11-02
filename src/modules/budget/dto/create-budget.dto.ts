import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBudgetDto {
  @ApiProperty({
    description: 'Budget name (unique per household, case-insensitive)',
    example: 'Monthly Budget 2025',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    description: 'Budget description',
    example: 'Monthly budget for household expenses',
  })
  @IsString()
  @IsOptional()
  description?: string;
}
