import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Max,
  ValidateBy,
  ValidateNested,
  type ValidationArguments,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { MAX_MONEY_AMOUNT } from '../../../common/utils/money.util';
import { IsCalendarDate } from '../../../common/validators/is-calendar-date';
import { MaxDecimalPlaces } from '../../../common/validators/max-decimal-places';
import { NotAfterTomorrow } from '../../../common/validators/not-after-tomorrow';

export const MAX_MANUAL_BATCH_ROWS = 50;
/** The length of a bill line's `raw_name`, where the note is kept. */
export const MAX_MANUAL_NOTE_LENGTH = 255;
export const MAX_MANUAL_MARKET_NAME_LENGTH = 255;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** One manual expense: it becomes a confirmed bill with one line. */
export class ManualBatchRowDto {
  @ApiProperty({
    example: '2026-11-09',
    format: 'date',
    description: 'At most tomorrow (Chisinau time)',
  })
  @IsCalendarDate()
  @NotAfterTomorrow()
  bill_date!: string;

  @ApiProperty({ example: 1.5 })
  @IsNumber()
  @MaxDecimalPlaces(2)
  @IsPositive()
  @Max(MAX_MONEY_AMOUNT)
  amount!: number;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  category_id!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Must be a sub-category of category_id',
  })
  @IsUUID()
  @IsOptional()
  sub_category_id?: string;

  @ApiPropertyOptional({
    example: 'coffee',
    maxLength: MAX_MANUAL_NOTE_LENGTH,
    description:
      "The line's name; the sub-category's or the category's name when omitted",
  })
  @Transform(trim)
  @IsString()
  @Length(1, MAX_MANUAL_NOTE_LENGTH)
  @IsOptional()
  note?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'A market of the household; not with market_name',
  })
  @IsUUID()
  @ValidateBy({
    name: 'notWithMarketName',
    validator: {
      validate: (_: unknown, args?: ValidationArguments): boolean =>
        (args?.object as ManualBatchRowDto).market_name == null,
      defaultMessage: () => 'Send market_id or market_name, not both',
    },
  })
  @IsOptional()
  market_id?: string;

  @ApiPropertyOptional({
    example: 'Kiosk',
    maxLength: MAX_MANUAL_MARKET_NAME_LENGTH,
    description:
      "The household's market of this name (ignoring case), created when there is none; not with market_id",
  })
  @Transform(trim)
  @IsString()
  @Length(1, MAX_MANUAL_MARKET_NAME_LENGTH)
  @IsOptional()
  market_name?: string;

  @ApiPropertyOptional({
    enum: Currency,
    description: "The household's currency when omitted",
  })
  @IsEnum(Currency)
  @IsOptional()
  currency?: Currency;
}

export class ManualBatchDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'A new key for each submit of the form; resending it returns the bills it saved',
  })
  @IsUUID()
  client_batch_id!: string;

  @ApiProperty({
    type: [ManualBatchRowDto],
    minItems: 1,
    maxItems: MAX_MANUAL_BATCH_ROWS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MANUAL_BATCH_ROWS)
  @ValidateNested({ each: true })
  @Type(() => ManualBatchRowDto)
  rows!: ManualBatchRowDto[];
}
