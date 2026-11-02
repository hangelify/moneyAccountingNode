import { ApiProperty } from '@nestjs/swagger';
import { CategoryResponseDto } from '../../category/dto/category-response.dto';
import { PlaningHorizonBaseResponseDto } from './planing-horizon-base-response.dto';

/**
 * Extended DTO for planning horizon GET response (includes categories)
 * Extends the base DTO to avoid duplication
 */
export class PlaningHorizonResponseDto extends PlaningHorizonBaseResponseDto {
  @ApiProperty({
    description: 'Categories linked to this planning horizon',
    type: [CategoryResponseDto],
  })
  categories!: CategoryResponseDto[];
}
