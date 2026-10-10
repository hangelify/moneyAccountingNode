import {
  IsUUID,
  IsDateString,
  IsEnum,
  IsNumber,
  IsString,
  IsOptional,
  IsInt,
  IsPositive,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';

export const MAX_BILL_ITEMS = 200;

export class CreateBillItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sub_category_id!: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  product_count!: number;

  @ApiProperty({ example: 8.99 })
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({ example: 1.234, description: 'Weight in kg' })
  @IsNumber()
  @IsOptional()
  product_weight?: number;
}

export class CreateBillDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  market_id?: string;

  @ApiProperty({ example: '2026-05-19' })
  @IsDateString()
  bill_date!: string;

  @ApiPropertyOptional({ enum: Currency })
  @IsEnum(Currency)
  @IsOptional()
  currency?: Currency;

  @ApiProperty({ example: 23.45 })
  @IsNumber()
  @IsPositive()
  total_amount!: number;

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
