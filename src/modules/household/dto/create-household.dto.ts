import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';

export class CreateHouseholdDto {
  @ApiProperty({ example: 'Family Budget' })
  @IsString()
  @Length(1, 255)
  name!: string;

  @ApiPropertyOptional({
    enum: Currency,
    description: "Defaults to the creator's currency",
  })
  @IsOptional()
  @IsEnum(Currency)
  currency?: Currency;
}
