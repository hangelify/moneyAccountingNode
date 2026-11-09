import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const MAX_RECENT_CATEGORIES = 50;
export const DEFAULT_RECENT_CATEGORIES = 10;
/** How far back a use counts. */
export const RECENT_CATEGORIES_DAYS = 90;

export class RecentCategoriesQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_RECENT_CATEGORIES,
    default: DEFAULT_RECENT_CATEGORIES,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RECENT_CATEGORIES)
  @IsOptional()
  limit?: number;
}

export class RecentCategoryRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Food' })
  name!: string;
}

export class RecentCategoryDto {
  @ApiProperty({ type: RecentCategoryRefDto })
  category!: RecentCategoryRefDto;

  @ApiProperty({
    type: RecentCategoryRefDto,
    nullable: true,
    description: 'null for lines saved with the category alone',
  })
  sub_category!: RecentCategoryRefDto | null;

  @ApiProperty({
    example: '2026-11-08',
    format: 'date',
    description: 'bill_date of the newest bill that used the pair',
  })
  last_used_at!: string;
}
