import { ApiPropertyOptional } from '@nestjs/swagger';
import { SubCategoryResponseDto } from '../../sub-category/dto/sub-category-response.dto';
import { CategoryBaseResponseDto } from './category-base-response.dto';

/**
 * Extended DTO for category GET response (includes sub-categories)
 * Extends the base DTO to avoid duplication
 */
export class CategoryResponseDto extends CategoryBaseResponseDto {
  @ApiPropertyOptional({
    description: 'Sub-categories belonging to this category',
    type: [SubCategoryResponseDto],
  })
  sub_categories?: SubCategoryResponseDto[];
}
