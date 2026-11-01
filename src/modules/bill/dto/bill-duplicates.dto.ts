import { IsOptional, IsUUID } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsCalendarDate } from '../../../common/validators/is-calendar-date';
import { Currency } from '../../../types/currency.enum';
import type { DuplicateMatch } from '../bill-duplicates';

export class PossibleDuplicateDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '2026-10-03', description: 'YYYY-MM-DD' })
  bill_date!: string;

  @ApiProperty({ example: 412.5 })
  total_amount!: number;

  @ApiProperty({ enum: Currency, nullable: true })
  currency!: Currency | null;

  @ApiProperty({ example: 'Linella', nullable: true })
  market_name!: string | null;

  @ApiProperty({ example: 'Ana', nullable: true })
  created_by_name!: string | null;

  @ApiPropertyOptional({
    enum: ['fiscal', 'strong', 'weak'],
    description:
      'fiscal: same receipt ids; strong: same amount, date and market or time; weak: same amount and date',
  })
  match?: DuplicateMatch;
}

export class MarkDuplicateDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'The bill this one is a copy of; when it is a duplicate itself, the link goes to its original',
  })
  @IsUUID()
  duplicate_of_id!: string;
}

export class DismissDuplicateDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'The other bill of the pair that is kept as a separate purchase',
  })
  @IsUUID()
  other_bill_id!: string;
}

export class DuplicateSuggestionsQueryDto {
  @ApiPropertyOptional({
    example: '2026-01-01',
    format: 'date',
    description:
      'Only pairs of bills with bill_date >= this date (YYYY-MM-DD). Omit to start from the beginning.',
  })
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsOptional()
  @IsCalendarDate()
  date_from?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    format: 'date',
    description:
      'Only pairs of bills with bill_date <= this date (YYYY-MM-DD). Omit for no upper bound.',
  })
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsOptional()
  @IsCalendarDate()
  date_to?: string;
}

export class DuplicatePairDto {
  @ApiProperty({
    type: () => PossibleDuplicateDto,
    description: 'The bill with the smaller id of the pair',
  })
  @Type(() => PossibleDuplicateDto)
  bill!: PossibleDuplicateDto;

  @ApiProperty({ type: () => PossibleDuplicateDto })
  @Type(() => PossibleDuplicateDto)
  other!: PossibleDuplicateDto;

  @ApiProperty({ enum: ['fiscal', 'strong', 'weak'] })
  match!: DuplicateMatch;
}

export class DuplicateSuggestionsResponseDto {
  @ApiProperty({
    type: [DuplicatePairDto],
    description:
      'At most 100 pairs, best match first, then newest purchase first',
  })
  pairs!: DuplicatePairDto[];
}
