import {
  IsUUID,
  IsDateString,
  IsEnum,
  IsNumber,
  IsString,
  IsOptional,
  IsPositive,
  Max,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { MAX_MONEY_AMOUNT } from '../../../common/utils/money.util';
import { MaxDecimalPlaces } from '../../../common/validators/max-decimal-places';

export class UpdateBillDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  market_id?: string;

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
  @MaxDecimalPlaces(2)
  @IsPositive()
  @Max(MAX_MONEY_AMOUNT)
  @IsOptional()
  total_amount?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;
}
