import {
  IsUUID,
  IsEnum,
  IsNumber,
  IsString,
  IsOptional,
  IsPositive,
  Max,
  Length,
  Matches,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { MAX_MONEY_AMOUNT } from '../../../common/utils/money.util';
import { IsCalendarDate } from '../../../common/validators/is-calendar-date';
import { MaxDecimalPlaces } from '../../../common/validators/max-decimal-places';
import {
  MAX_FISCAL_ID_LENGTH,
  PURCHASE_TIME_PATTERN,
} from '../tasks/schemas/parsed-bill.schema';

export class UpdateBillDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  market_id?: string;

  @ApiPropertyOptional({ example: '2026-05-19', format: 'date' })
  @IsCalendarDate()
  @IsOptional()
  bill_date?: string;

  @ApiPropertyOptional({ enum: Currency })
  @IsEnum(Currency)
  @IsOptional()
  currency?: Currency;

  @ApiPropertyOptional({ example: 23.45 })
  @IsNumber()
  @MaxDecimalPlaces(2)
  @IsPositive()
  @Max(MAX_MONEY_AMOUNT)
  @IsOptional()
  total_amount?: number;

  @ApiPropertyOptional()
  @IsString()
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
}
