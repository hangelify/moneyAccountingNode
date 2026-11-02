import { ApiProperty } from '@nestjs/swagger';

export class SeedDefaultsResponseDto {
  @ApiProperty({ example: 12, description: 'Number of categories created' })
  categories_created!: number;

  @ApiProperty({ example: 70, description: 'Number of subcategories created' })
  sub_categories_created!: number;
}
