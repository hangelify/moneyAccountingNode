import { ApiProperty } from '@nestjs/swagger';
import { BillListItemDto } from './bill-response.dto';

export class ManualBatchResponseDto {
  @ApiProperty({ format: 'uuid' })
  client_batch_id!: string;

  @ApiProperty({
    type: [BillListItemDto],
    description:
      'One bill per row, in row order; on a replay, the bills the first submit saved',
  })
  bills!: BillListItemDto[];
}

export class ManualBatchRowErrorDto {
  @ApiProperty({ example: 2, description: 'The row, from 0' })
  index!: number;

  @ApiProperty({ example: 'category_id' })
  field!: string;

  @ApiProperty({ example: 'Category not found' })
  message!: string;
}

export class ManualBatchErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Some rows are invalid' })
  message!: string;

  @ApiProperty({ type: [ManualBatchRowErrorDto] })
  errors!: ManualBatchRowErrorDto[];
}
