import {
  IsUUID,
  IsDateString,
  IsEnum,
  IsNumber,
  IsString,
  IsOptional,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsPositive,
  Length,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { CreateBillItemDto, MAX_BILL_ITEMS } from './create-bill.dto';

export class NewMarketDto {
  @ApiProperty({ example: 'Lidl' })
  @IsString()
  @Length(1, 255)
  name!: string;

  @ApiPropertyOptional({ example: 'Bucharest' })
  @IsString()
  @IsOptional()
  @Length(1, 255)
  city?: string;

  @ApiPropertyOptional({ example: 'RO' })
  @IsString()
  @IsOptional()
  @Length(2, 2)
  country?: string;

  @ApiPropertyOptional({ example: 'Calea Moșilor 123' })
  @IsString()
  @IsOptional()
  @Length(1, 500)
  address?: string;
}

export class ConfirmBillDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Use an existing market',
  })
  @IsUUID()
  @IsOptional()
  market_id?: string;

  @ApiPropertyOptional({
    type: NewMarketDto,
    description: 'Auto find-or-create a market by name',
  })
  @ValidateNested()
  @Type(() => NewMarketDto)
  @IsOptional()
  new_market?: NewMarketDto;

  @ApiPropertyOptional({ example: '2026-05-19' })
  @IsDateString()
  @IsOptional()
  bill_date?: string;

  @ApiPropertyOptional({ enum: Currency })
  @IsEnum(Currency)
  @IsOptional()
  currency?: Currency;

  @ApiPropertyOptional({ example: 23.45 })
  @IsNumber()
  @IsPositive()
  @IsOptional()
  total_amount?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    type: [CreateBillItemDto],
    minItems: 1,
    maxItems: MAX_BILL_ITEMS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BILL_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => CreateBillItemDto)
  items!: CreateBillItemDto[];
}
