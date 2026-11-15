import { IsArray, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { CreateCategoryItemDto } from './create-category-item.dto';

export class BulkCreateCategoryDto {
  @ApiProperty({
    description: 'Array of categories to create',
    type: [CreateCategoryItemDto],
    example: [
      { name: 'Food & Dining', description: 'Expenses related to food' },
      { name: 'Transportation', description: 'Transportation expenses' },
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateCategoryItemDto)
  categories!: CreateCategoryItemDto[];
}
