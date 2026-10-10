import { ApiProperty } from '@nestjs/swagger';

export class SubCategoryRefDto {
  @ApiProperty({
    format: 'uuid',
    example: '00000000-0000-0000-0000-000000000001',
  })
  id!: string;

  @ApiProperty({ example: 'bun' })
  name!: string;

  @ApiProperty({ example: 'Bread' })
  category_name!: string;
}

export class ParsedBillItemResponseDto {
  @ApiProperty({ example: 'BREAD' })
  name!: string;

  @ApiProperty({ nullable: true, example: 1 })
  quantity!: number | null;

  @ApiProperty({ enum: ['kg', 'g', 'l', 'ml', 'piece'], nullable: true })
  unit!: 'kg' | 'g' | 'l' | 'ml' | 'piece' | null;

  @ApiProperty({ nullable: true, example: 1.234 })
  weight_kg!: number | null;

  @ApiProperty({ nullable: true, example: 8.99 })
  price_per_kg!: number | null;

  @ApiProperty({ example: 1.2 })
  final_price!: number;

  @ApiProperty({ type: SubCategoryRefDto, nullable: true })
  sub_category!: SubCategoryRefDto | null;

  @ApiProperty({ minimum: 0, maximum: 1, example: 0.94 })
  category_confidence!: number;

  @ApiProperty({ required: false, example: 'Piece-priced bread product.' })
  category_reasoning?: string;
}

export class ParsedBillResponseDto {
  @ApiProperty({ format: 'uuid', description: 'UUID of the saved draft bill' })
  draft_id!: string;

  @ApiProperty({ nullable: true, example: 'Lidl' })
  market_name!: string | null;

  @ApiProperty({ nullable: true, example: '2026-05-07' })
  bill_date!: string | null;

  @ApiProperty({ nullable: true, example: 'EUR' })
  currency!: string | null;

  @ApiProperty({ nullable: true, example: 23.45 })
  total_amount!: number | null;

  @ApiProperty({ type: [ParsedBillItemResponseDto] })
  items!: ParsedBillItemResponseDto[];
}
