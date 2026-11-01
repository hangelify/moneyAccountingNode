import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
