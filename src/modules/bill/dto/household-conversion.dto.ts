import { ApiProperty } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';

/** Bills of one original currency that could not be converted. */
export class UnconvertedDto {
  @ApiProperty({
    enum: Currency,
    nullable: true,
    description: 'Original currency; null for bills without a currency',
  })
  currency!: Currency | null;

  @ApiProperty({ example: 2 })
  bill_count!: number;

  @ApiProperty({ example: 31, description: 'Sum in the original currency' })
  amount!: number;
}

export class BillExchangeRateDto {
  @ApiProperty({
    example: 0.04,
    description:
      "Household currency per one unit of the bill's currency (6 decimals)",
  })
  rate!: number;

  @ApiProperty({
    example: '2026-03-07',
    format: 'date',
    description: 'Day of the saved rates used; may be before bill_date',
  })
  rate_date!: string;
}
