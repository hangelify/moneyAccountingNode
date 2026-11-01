import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BillResponseDto } from './bill-response.dto';
import { PaginationMetaDto } from './bill-list-response.dto';
import { SubCategoryRefDto } from './parsed-bill-response.dto';
import { BillStatus } from '../../../types/bill-status.enum';
import { BillExchangeRateDto } from './household-conversion.dto';

export class BillItemResponseDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Line id; send it back in confirm to update the line in place',
  })
  id!: string;

  @ApiProperty({ type: SubCategoryRefDto, nullable: true })
  sub_category!: SubCategoryRefDto | null;

  @ApiProperty({ example: 2 })
  product_count!: number;

  @ApiProperty({ example: 8.99 })
  amount!: number;

  @ApiPropertyOptional({ example: 1.234 })
  product_weight?: number;

  @ApiProperty({
    example: 'BREAD 500G',
    description: 'Product name as printed on the receipt',
  })
  raw_name!: string;

  @ApiPropertyOptional({ example: 'kg', enum: ['kg', 'g', 'l', 'ml', 'piece'] })
  unit?: string;

  @ApiPropertyOptional({ example: 8.99 })
  price_per_unit?: number;

  @ApiPropertyOptional({
    example: 0.92,
    description: 'AI categorization confidence (0..1)',
  })
  category_confidence?: number;

  @ApiPropertyOptional({ description: 'Why the AI picked the sub-category' })
  category_reasoning?: string;
}

export class BillDetailResponseDto extends BillResponseDto {
  @ApiProperty({ enum: BillStatus, enumName: 'BillStatus' })
  status!: BillStatus;

  @ApiPropertyOptional({
    example: 'LIDL DISCOUNT SRL',
    description: 'Store name as read from the receipt',
  })
  market_name_raw?: string;

  @ApiProperty({
    description:
      'True when no date was read from the receipt and bill_date is the upload day',
  })
  bill_date_inferred!: boolean;

  @ApiProperty({ nullable: true, example: 'J403001234' })
  fiscal_register_id!: string | null;

  @ApiProperty({ nullable: true, example: '0042' })
  fiscal_receipt_number!: string | null;

  @ApiProperty({ nullable: true, example: '14:05', description: 'HH:MM' })
  purchase_time!: string | null;

  @ApiProperty({ type: [BillItemResponseDto] })
  items!: BillItemResponseDto[];

  @ApiPropertyOptional({
    type: BillExchangeRateDto,
    nullable: true,
    description:
      'Rate used for household_amount; null when the bill is in the household currency or cannot be converted',
  })
  exchange_rate?: BillExchangeRateDto | null;
}

export class DraftListResponseDto {
  @ApiProperty({ type: [BillDetailResponseDto] })
  data!: BillDetailResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}

export class DraftImageResponseDto {
  @ApiProperty({
    example:
      'https://s3.example.com/receipts/ai/images/abc.jpg?X-Amz-Signature=...',
    description: 'Presigned GET URL of the receipt photo',
  })
  url!: string;

  @ApiProperty({ example: 300, description: 'Seconds the URL stays valid' })
  expires_in!: number;
}
