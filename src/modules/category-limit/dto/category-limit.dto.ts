import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsUUID,
  Max,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { LimitPeriodType } from '../../../types/limit-period-type.enum';
import { MAX_MONEY_AMOUNT } from '../../../common/utils/money.util';
import { MaxDecimalPlaces } from '../../../common/validators/max-decimal-places';

/** One version of a category's spending limit. */
export class CategoryLimitDto {
  @ApiProperty({
    description: 'Limit version id; changes when the limit is rewritten',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'Category id; addresses the limit in PUT and DELETE',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  category_id!: string;

  @ApiProperty({ description: 'Category name', example: 'Food' })
  category_name!: string;

  @ApiProperty({
    description: 'True when the category is deleted (archived)',
    example: false,
  })
  category_archived!: boolean;

  @ApiProperty({
    description: 'Calendar period the limit applies to',
    enum: LimitPeriodType,
    example: LimitPeriodType.MONTHLY,
  })
  period_type!: LimitPeriodType;

  @ApiProperty({ description: 'Limit per period', example: 300 })
  amount!: number;

  @ApiProperty({
    description: 'Household currency when the version was written',
    enum: Currency,
    example: Currency.EUR,
  })
  currency!: Currency;

  @ApiProperty({
    description: 'First day the version applies (YYYY-MM-DD)',
    example: '2026-11-01',
  })
  effective_from!: string;

  @ApiProperty({
    description:
      'First day the version no longer applies (YYYY-MM-DD); null while open',
    example: null,
    type: String,
    nullable: true,
  })
  effective_to!: string | null;
}

/** Body of `PUT`: the new limit of a category that has one. */
export class UpdateCategoryLimitDto {
  @ApiProperty({
    description: 'Calendar period the limit applies to',
    enum: LimitPeriodType,
    example: LimitPeriodType.MONTHLY,
  })
  @IsEnum(LimitPeriodType)
  period_type!: LimitPeriodType;

  @ApiProperty({
    description: 'Limit per period, in the household currency',
    example: 300,
    minimum: 0,
    exclusiveMinimum: true,
    maximum: MAX_MONEY_AMOUNT,
  })
  @IsNumber()
  @MaxDecimalPlaces(2)
  @IsPositive()
  @Max(MAX_MONEY_AMOUNT)
  amount!: number;
}

/** Body of `POST`: a limit for a category that has none open. */
export class CreateCategoryLimitDto extends UpdateCategoryLimitDto {
  @ApiProperty({
    description: 'Category of the household',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  category_id!: string;
}

const parseBooleanQuery = (value: unknown): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

/** Query of `GET`: whether closed versions are listed too. */
export class ListCategoryLimitsQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'List every version, including closed and future ones; by default only the versions in force today.',
  })
  @Transform(({ value }: { value: unknown }) => parseBooleanQuery(value))
  @IsOptional()
  @IsBoolean()
  include_history?: boolean;
}
