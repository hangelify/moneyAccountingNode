import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Saved draft line; send it back in confirm to update the line in place',
  })
  id?: string;

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

export class ParsePhotoResponseDto extends ParsedBillResponseDto {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description:
      'Id of the audited AI request, for support and audit lookup; null for a re-uploaded photo whose AI request was purged',
  })
  request_id!: string | null;

  @ApiProperty({
    description:
      'True when this photo already had an open draft: that draft is returned and no AI call is made',
  })
  duplicate!: boolean;
}

/** Error body of the AI endpoints (see `aiErrorBody`); some add fields, e.g. `parsed`. */
export class AiErrorResponseDto {
  @ApiProperty({ example: 503 })
  statusCode!: number;

  @ApiProperty({ example: 'Service Unavailable' })
  error!: string;

  @ApiProperty({ example: 'AI providers are unavailable, try again later' })
  message!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Id of the audited AI request; null when the request failed before the AI call was audited (auth, upload checks, limits)',
  })
  request_id!: string | null;
}
