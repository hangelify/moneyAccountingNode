import {
  IsUUID,
  IsEnum,
  IsNumber,
  IsString,
  IsOptional,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsPositive,
  Max,
  Length,
  Matches,
  ValidateIf,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { MAX_MONEY_AMOUNT } from '../../../common/utils/money.util';
import { IsCalendarDate } from '../../../common/validators/is-calendar-date';
import { MaxDecimalPlaces } from '../../../common/validators/max-decimal-places';
import {
  CreateBillItemDto,
  MAX_BILL_DESCRIPTION_LENGTH,
  MAX_BILL_ITEMS,
} from './create-bill.dto';
import {
  MAX_FISCAL_ID_LENGTH,
  PURCHASE_TIME_PATTERN,
} from '../tasks/schemas/parsed-bill.schema';

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

export class ConfirmBillItemDto extends OmitType(CreateBillItemDto, [
  'sub_category_id',
] as const) {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Draft line this item updates in place, keeping what the model read (unit, confidence); omit for a new line. Draft lines left out are removed.',
  })
  @IsUUID()
  @IsOptional()
  id?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Omit to confirm the line without a sub-category: under category_id, or uncategorized without one',
  })
  @IsUUID()
  @IsOptional()
  sub_category_id?: string | null;

  @ApiPropertyOptional({
    example: 'LAPTE 1L',
    description:
      'Name as printed on the receipt. Defaults to the draft line name, else the sub-category name, else the category name; required on a new line with neither.',
  })
  @ValidateIf(
    (o: ConfirmBillItemDto) =>
      o.raw_name !== undefined ||
      (!o.id && !o.sub_category_id && !o.category_id),
  )
  @IsString()
  @Length(1, 255)
  raw_name?: string;
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
    type: [ConfirmBillItemDto],
    minItems: 1,
    maxItems: MAX_BILL_ITEMS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BILL_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => ConfirmBillItemDto)
  items!: ConfirmBillItemDto[];
}
