import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const MAX_MOVE_BILLS = 100;

export class MoveBillsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: MAX_MOVE_BILLS,
    uniqueItems: true,
    description: 'The bills to move, all of the household in the path',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MOVE_BILLS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  bill_ids!: string[];

  @ApiProperty({
    format: 'uuid',
    description:
      'The household to move the bills to; the caller must be an owner or member of it',
  })
  @IsUUID('4')
  target_household_id!: string;
}

export class MovedBillDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 5, description: 'Lines of the bill' })
  lines_total!: number;

  @ApiProperty({
    example: 1,
    description:
      'Lines that lost their sub-category: the target household has no such one',
  })
  lines_lost_sub_category!: number;

  @ApiProperty({
    example: 0,
    description:
      'Lines that lost their category: the target household has no such one',
  })
  lines_lost_category!: number;

  @ApiProperty({
    description:
      'True when the bill was already in the target household (a retry)',
  })
  already_moved!: boolean;
}

export class MoveBillsResponseDto {
  @ApiProperty({ format: 'uuid' })
  target_household_id!: string;

  @ApiProperty({ type: [MovedBillDto], description: 'One per requested bill' })
  bills!: MovedBillDto[];
}

export enum MoveConflictReason {
  STATUS_NOT_MOVABLE = 'status_not_movable',
  HAS_DUPLICATES = 'has_duplicates',
  DRAFT_IMAGE_CONFLICT = 'draft_image_conflict',
  CLIENT_BATCH_CONFLICT = 'client_batch_conflict',
}

export class MoveBillConflictDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: MoveConflictReason, enumName: 'MoveConflictReason' })
  reason!: MoveConflictReason;
}

export class MoveBillsConflictResponseDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ example: 'Some bills cannot be moved' })
  message!: string;

  @ApiProperty({
    type: [MoveBillConflictDto],
    description: 'Nothing was moved when this is returned',
  })
  conflicts!: MoveBillConflictDto[];
}

export class MoveBillsNotFoundResponseDto {
  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiProperty({ example: 'Some bills were not found' })
  message!: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'The ids that are not bills of the household in the path',
  })
  bill_ids!: string[];
}
