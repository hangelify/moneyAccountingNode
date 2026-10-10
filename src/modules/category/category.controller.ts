import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  ParseUUIDPipe,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { CategoryService } from './category.service';
import { CategoryDefaultsService } from './category-defaults.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { BulkCreateCategoryDto } from './dto/bulk-create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CategoryResponseDto } from './dto/category-response.dto';
import { CategoryBaseResponseDto } from './dto/category-base-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HouseholdMemberGuard } from '../household/guards/household-member.guard';
import type { HouseholdContext } from '../household/guards/household-member.guard';
import { CurrentHousehold } from '../household/decorators/current-household.decorator';
import {
  ApiCreateCategoryResponses,
  ApiBulkCreateCategoryResponses,
  ApiGetCategoryResponses,
  ApiGetAllCategoriesResponses,
  ApiUpdateCategoryResponses,
  ApiDeleteCategoryResponses,
  ApiSeedDefaultCategoriesResponses,
} from './decorators/api-responses.decorator';

@ApiTags('categories')
@Controller('households/:hid/categories')
@UseGuards(JwtAuthGuard, HouseholdMemberGuard)
@ApiBearerAuth('JWT-auth')
export class CategoryController {
  constructor(
    private readonly categoryService: CategoryService,
    private readonly categoryDefaultsService: CategoryDefaultsService,
  ) {}

  @Post('seed-defaults')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Seed (or restore) the default category tree for the household. Idempotent.',
  })
  @ApiSeedDefaultCategoriesResponses()
  async seedDefaults(@CurrentHousehold() ctx: HouseholdContext): Promise<void> {
    await this.categoryDefaultsService.seedForHousehold(ctx.householdId);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Bulk create categories for a planning horizon' })
  @ApiBulkCreateCategoryResponses()
  async bulkCreateCategories(
    @CurrentHousehold() ctx: HouseholdContext,
    @Body() bulkCreateCategoryDto: BulkCreateCategoryDto,
  ): Promise<CategoryResponseDto[]> {
    return this.categoryService.bulkCreateCategories(
      ctx.householdId,
      bulkCreateCategoryDto,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new category' })
  @ApiCreateCategoryResponses()
  async createCategory(
    @CurrentHousehold() ctx: HouseholdContext,
    @Body() createCategoryDto: CreateCategoryDto,
  ): Promise<CategoryResponseDto> {
    return this.categoryService.createCategory(
      ctx.householdId,
      createCategoryDto,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Get all household categories' })
  @ApiGetAllCategoriesResponses()
  async getAllUserCategories(
    @CurrentHousehold() ctx: HouseholdContext,
  ): Promise<CategoryBaseResponseDto[]> {
    return this.categoryService.getAllUserCategories(ctx.householdId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a category by ID' })
  @ApiParam({
    name: 'id',
    description: 'Category unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiGetCategoryResponses()
  async getCategory(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CategoryResponseDto> {
    return this.categoryService.getCategory(id, ctx.householdId);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a category by ID' })
  @ApiParam({
    name: 'id',
    description: 'Category unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiUpdateCategoryResponses()
  async updateCategory(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    return this.categoryService.updateCategory(
      id,
      ctx.householdId,
      updateCategoryDto,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a category by ID' })
  @ApiParam({
    name: 'id',
    description: 'Category unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiDeleteCategoryResponses()
  async deleteCategory(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.categoryService.deleteCategory(id, ctx.householdId);
  }
}
