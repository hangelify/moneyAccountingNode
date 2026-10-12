import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';

export class BillMarketRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Lidl' })
  name!: string;

  @ApiPropertyOptional({ example: 'Bucharest' })
  city?: string;
}

export class BillResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '2026-05-19', format: 'date' })
  bill_date!: string;

  @ApiPropertyOptional({ enum: Currency })
  currency?: Currency;

  @ApiProperty({ example: 23.45 })
  total_amount!: number;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional({ type: BillMarketRefDto })
  market?: BillMarketRefDto;

  @ApiProperty({ type: Date })
  created_at!: Date;
}
