import { ApiProperty } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { BillListItemDto } from './bill-response.dto';
import { PaginationMetaDto } from './bill-list-response.dto';

export class BillByCategoryItemDto extends BillListItemDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 30,
    description:
      "Sum of the bill's lines in the category, in household_currency at the official rate of bill_date; null when no rate is saved",
  })
  category_amount!: number | null;
}

export class BillsCategoryRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Food' })
  name!: string;

  @ApiProperty({
    example: false,
    description: 'The category is archived (soft-deleted)',
  })
  archived!: boolean;
}

export class BillsByCategoryResponseDto {
  @ApiProperty({ type: [BillByCategoryItemDto] })
  data!: BillByCategoryItemDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;

  @ApiProperty({ type: BillsCategoryRefDto })
  category!: BillsCategoryRefDto;

  @ApiProperty({
    example: 312.5,
    description:
      "Sum of the category's lines over every page of the filters, in household_currency, rounded as the limits report does; lines without a rate are left out",
  })
  category_total!: number;

  @ApiProperty({ enum: Currency, description: 'Currency of every amount here' })
  household_currency!: Currency;

  @ApiProperty({
    example: 0,
    description: 'Category lines left out of category_total for lack of a rate',
  })
  unconverted_lines!: number;
}
