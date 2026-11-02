import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MarketResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Lidl' })
  name!: string;

  @ApiPropertyOptional({ example: 'Calea Moșilor 123' })
  address?: string;

  @ApiPropertyOptional({ example: 'Bucharest' })
  city?: string;

  @ApiPropertyOptional({ example: 'RO' })
  country?: string;

  @ApiProperty({ type: Date })
  created_at!: Date;

  @ApiProperty({
    example: 3,
    description: 'Number of confirmed bills using this market',
  })
  bill_count!: number;
}
