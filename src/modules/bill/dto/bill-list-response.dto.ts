import { ApiProperty } from '@nestjs/swagger';
import { BillListItemDto } from './bill-response.dto';

export class PaginationMetaDto {
  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 3 })
  total_pages!: number;
}

export class BillListResponseDto {
  @ApiProperty({ type: [BillListItemDto] })
  data!: BillListItemDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}
