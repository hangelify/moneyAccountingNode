import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, JwtAuthGuard } from '../auth';
import type { AuthenticatedUser } from '../auth';
import { CurrentHousehold, HouseholdMemberGuard } from '../household';
import type { HouseholdContext } from '../household';
import { CategoryLimitService } from './category-limit.service';
import {
  CategoryLimitDto,
  CreateCategoryLimitDto,
  ListCategoryLimitsQueryDto,
  UpdateCategoryLimitDto,
} from './dto/category-limit.dto';
import {
  ApiCreateCategoryLimitResponses,
  ApiDeleteCategoryLimitResponses,
  ApiListCategoryLimitsResponses,
  ApiUpdateCategoryLimitResponses,
} from './decorators/api-responses.decorator';

const CATEGORY_ID_PARAM = {
  name: 'categoryId',
  description: 'Category whose limit is addressed',
  example: '123e4567-e89b-12d3-a456-426614174000',
};

@ApiTags('category-limits')
@Controller('households/:hid/category-limits')
@UseGuards(JwtAuthGuard, HouseholdMemberGuard)
@ApiBearerAuth('JWT-auth')
export class CategoryLimitController {
  constructor(private readonly limits: CategoryLimitService) {}

  @Get()
  @ApiOperation({ summary: 'List category spending limits' })
  @ApiListCategoryLimitsResponses()
  list(
    @CurrentHousehold() ctx: HouseholdContext,
    @Query() query: ListCategoryLimitsQueryDto,
  ): Promise<CategoryLimitDto[]> {
    return this.limits.list(ctx.householdId, query.include_history ?? false);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Set a limit on a category that has none' })
  @ApiCreateCategoryLimitResponses()
  create(
    @CurrentHousehold() ctx: HouseholdContext,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCategoryLimitDto,
  ): Promise<CategoryLimitDto> {
    return this.limits.create(ctx.householdId, user.id, dto);
  }

  @Put(':categoryId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Replace a category's limit" })
  @ApiParam(CATEGORY_ID_PARAM)
  @ApiUpdateCategoryLimitResponses()
  update(
    @CurrentHousehold() ctx: HouseholdContext,
    @CurrentUser() user: AuthenticatedUser,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: UpdateCategoryLimitDto,
  ): Promise<CategoryLimitDto> {
    return this.limits.update(ctx.householdId, user.id, categoryId, dto);
  }

  @Delete(':categoryId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Remove a category's limit at the end of its period",
  })
  @ApiParam(CATEGORY_ID_PARAM)
  @ApiDeleteCategoryLimitResponses()
  remove(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
  ): Promise<CategoryLimitDto> {
    return this.limits.remove(ctx.householdId, categoryId);
  }
}
