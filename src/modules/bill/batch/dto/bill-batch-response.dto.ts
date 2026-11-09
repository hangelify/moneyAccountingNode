import { ApiProperty } from '@nestjs/swagger';
import { BillBatchItemStatus } from '../../../../types/bill-batch-item-status.enum';
import { BillParseErrorCode } from '../../../../types/bill-parse-error.enum';

export class BillBatchItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 0, description: '0-based order in the upload' })
  position!: number;

  @ApiProperty({ enum: BillBatchItemStatus, example: BillBatchItemStatus.DONE })
  status!: BillBatchItemStatus;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'The draft or failed bill; null while queued or processing',
  })
  bill_id!: string | null;

  @ApiProperty({ enum: BillParseErrorCode, nullable: true })
  parse_error_code!: BillParseErrorCode | null;

  @ApiProperty({ nullable: true, type: String })
  parse_error_message!: string | null;
}

export class BillBatchResponseDto {
  @ApiProperty({ format: 'uuid' })
  batch_id!: string;

  @ApiProperty({ example: '2026-11-02T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: 3 })
  total!: number;

  @ApiProperty({ description: 'True when no item is queued or processing' })
  completed!: boolean;

  @ApiProperty({ type: [BillBatchItemDto] })
  items!: BillBatchItemDto[];
}
