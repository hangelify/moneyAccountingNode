import { IsEnum, IsString, Length, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';

// Omitted means unchanged. Not @IsOptional: it would let null through to the
// flush, and neither column can be cleared, so null fails validation (400).
export class UpdateHouseholdDto {
  @ApiPropertyOptional({ example: 'Family Budget 2026' })
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({ enum: Currency })
  @ValidateIf((_, v) => v !== undefined)
  @IsEnum(Currency)
  currency?: Currency;
}
