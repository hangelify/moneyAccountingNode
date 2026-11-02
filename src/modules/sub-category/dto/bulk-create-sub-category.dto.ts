import { IsArray, IsUUID, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { CreateSubCategoryItemDto } from './create-sub-category-item.dto';

export class BulkCreateSubCategoryDto {
  @ApiProperty({
    description: 'Category ID to link all sub-categories to',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  category_id!: string;

  @ApiProperty({
    description: 'Array of sub-categories to create',
    type: [CreateSubCategoryItemDto],
    example: [
      { name: 'Groceries', description: 'Weekly grocery shopping' },
      { name: 'Restaurants', description: 'Dining out expenses' },
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateSubCategoryItemDto)
  sub_categories!: CreateSubCategoryItemDto[];
}
