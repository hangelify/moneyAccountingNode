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
import { SubCategoryService } from './sub-category.service';
import { CreateSubCategoryDto } from './dto/create-sub-category.dto';
import { BulkCreateSubCategoryDto } from './dto/bulk-create-sub-category.dto';
import { UpdateSubCategoryDto } from './dto/update-sub-category.dto';
import { SubCategoryResponseDto } from './dto/sub-category-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HouseholdMemberGuard } from '../household/guards/household-member.guard';
import type { HouseholdContext } from '../household/guards/household-member.guard';
import { CurrentHousehold } from '../household/decorators/current-household.decorator';
import {
  ApiCreateSubCategoryResponses,
  ApiBulkCreateSubCategoryResponses,
  ApiGetSubCategoryResponses,
  ApiGetAllSubCategoriesResponses,
  ApiUpdateSubCategoryResponses,
  ApiDeleteSubCategoryResponses,
} from './decorators/api-responses.decorator';

@ApiTags('sub-categories')
@Controller('households/:hid/sub-categories')
@UseGuards(JwtAuthGuard, HouseholdMemberGuard)
@ApiBearerAuth('JWT-auth')
export class SubCategoryController {
  constructor(private readonly subCategoryService: SubCategoryService) {}

  @Post('bulk')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Bulk create sub-categories for a category' })
  @ApiBulkCreateSubCategoryResponses()
  async bulkCreateSubCategories(
    @CurrentHousehold() ctx: HouseholdContext,
    @Body() bulkCreateSubCategoryDto: BulkCreateSubCategoryDto,
  ): Promise<SubCategoryResponseDto[]> {
    return this.subCategoryService.bulkCreateSubCategories(
      ctx.householdId,
      bulkCreateSubCategoryDto,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new sub-category' })
  @ApiCreateSubCategoryResponses()
  async createSubCategory(
    @CurrentHousehold() ctx: HouseholdContext,
    @Body() createSubCategoryDto: CreateSubCategoryDto,
  ): Promise<SubCategoryResponseDto> {
    return this.subCategoryService.createSubCategory(
      ctx.householdId,
      createSubCategoryDto,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Get all household sub-categories' })
  @ApiGetAllSubCategoriesResponses()
  async getAllUserSubCategories(
    @CurrentHousehold() ctx: HouseholdContext,
  ): Promise<SubCategoryResponseDto[]> {
    return this.subCategoryService.getAllUserSubCategories(ctx.householdId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a sub-category by ID' })
  @ApiParam({
    name: 'id',
    description: 'Sub-category unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiGetSubCategoryResponses()
  async getSubCategory(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SubCategoryResponseDto> {
    return this.subCategoryService.getSubCategory(id, ctx.householdId);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a sub-category by ID' })
  @ApiParam({
    name: 'id',
    description: 'Sub-category unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiUpdateSubCategoryResponses()
  async updateSubCategory(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateSubCategoryDto: UpdateSubCategoryDto,
  ): Promise<SubCategoryResponseDto> {
    return this.subCategoryService.updateSubCategory(
      id,
      ctx.householdId,
      updateSubCategoryDto,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete a sub-category by ID' })
  @ApiParam({
    name: 'id',
    description: 'Sub-category unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiDeleteSubCategoryResponses()
  async deleteSubCategory(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.subCategoryService.softDeleteSubCategory(id, ctx.householdId);
  }
}
