import {
  IsUUID,
  IsEnum,
  IsNumber,
  IsString,
  IsOptional,
  IsInt,
  IsPositive,
  NotEquals,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  Min,
  Max,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { MAX_MONEY_AMOUNT } from '../../../common/utils/money.util';
import { IsCalendarDate } from '../../../common/validators/is-calendar-date';
import { MaxDecimalPlaces } from '../../../common/validators/max-decimal-places';
import {
  MAX_FISCAL_ID_LENGTH,
  MAX_WEIGHT_KG,
  PURCHASE_TIME_PATTERN,
} from '../tasks/schemas/parsed-bill.schema';

export const MAX_BILL_ITEMS = 200;
export const MAX_BILL_DESCRIPTION_LENGTH = 1000;

export class CreateBillItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sub_category_id!: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  product_count!: number;

  @ApiProperty({
    example: 8.99,
    description:
      'Amount paid for the item after discounts; negative for a sales or discount line. The items of a bill add up to its total_amount',
  })
  @IsNumber()
  @MaxDecimalPlaces(2)
  @NotEquals(0)
  @Min(-MAX_MONEY_AMOUNT)
  @Max(MAX_MONEY_AMOUNT)
  amount!: number;

  @ApiPropertyOptional({ example: 1.234, description: 'Weight in kg' })
  @IsNumber()
  @MaxDecimalPlaces(3)
  @IsPositive()
  @Max(MAX_WEIGHT_KG)
  @IsOptional()
  product_weight?: number;
}

export class CreateBillDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  market_id?: string;

  @ApiProperty({ example: '2026-05-19', format: 'date' })
  @IsCalendarDate()
  bill_date!: string;

  @ApiPropertyOptional({ enum: Currency })
  @IsEnum(Currency)
  @IsOptional()
  currency?: Currency;

  @ApiProperty({ example: 23.45 })
  @IsNumber()
  @MaxDecimalPlaces(2)
  @IsPositive()
  @Max(MAX_MONEY_AMOUNT)
  total_amount!: number;

  @ApiPropertyOptional({ maxLength: MAX_BILL_DESCRIPTION_LENGTH })
  @IsString()
  @MaxLength(MAX_BILL_DESCRIPTION_LENGTH)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    example: 'J403001234',
    description: 'Cash register / fiscal device id printed on the receipt',
  })
  @IsString()
  @Length(1, MAX_FISCAL_ID_LENGTH)
  @IsOptional()
  fiscal_register_id?: string;

  @ApiPropertyOptional({
    example: '0042',
    description: 'Receipt number printed on the receipt',
  })
  @IsString()
  @Length(1, MAX_FISCAL_ID_LENGTH)
  @IsOptional()
  fiscal_receipt_number?: string;

  @ApiPropertyOptional({ example: '14:05', description: 'HH:MM, 24-hour' })
  @IsString()
  @Matches(PURCHASE_TIME_PATTERN)
  @IsOptional()
  purchase_time?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Save the bill as a duplicate of this confirmed bill (or of its original, when it is a duplicate itself)',
  })
  @IsUUID()
  @IsOptional()
  duplicate_of_id?: string;

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
