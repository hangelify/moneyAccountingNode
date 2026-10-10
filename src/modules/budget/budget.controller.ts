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
import { BudgetService } from './budget.service';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { BudgetResponseDto } from './dto/budget-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HouseholdMemberGuard } from '../household/guards/household-member.guard';
import { CurrentHousehold } from '../household/decorators/current-household.decorator';
import type { HouseholdContext } from '../household/guards/household-member.guard';
import {
  ApiCreateBudgetResponses,
  ApiGetBudgetResponses,
  ApiUpdateBudgetResponses,
  ApiDeleteBudgetResponses,
  ApiListBudgetsResponses,
} from './decorators/api-responses.decorator';

@ApiTags('budgets')
@Controller('households/:hid/budgets')
@UseGuards(JwtAuthGuard, HouseholdMemberGuard)
@ApiBearerAuth('JWT-auth')
export class BudgetController {
  constructor(private readonly budgetService: BudgetService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new budget' })
  @ApiCreateBudgetResponses()
  async createBudget(
    @CurrentHousehold() ctx: HouseholdContext,
    @Body() createBudgetDto: CreateBudgetDto,
  ): Promise<BudgetResponseDto> {
    return this.budgetService.createBudget(ctx.householdId, createBudgetDto);
  }

  @Get()
  @ApiOperation({ summary: 'List all budgets for the current household' })
  @ApiListBudgetsResponses()
  async listBudgets(
    @CurrentHousehold() ctx: HouseholdContext,
  ): Promise<BudgetResponseDto[]> {
    return this.budgetService.listBudgets(ctx.householdId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a budget by ID' })
  @ApiParam({
    name: 'id',
    description: 'Budget unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiGetBudgetResponses()
  async getBudget(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BudgetResponseDto> {
    return this.budgetService.getBudget(id, ctx.householdId);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a budget by ID' })
  @ApiParam({
    name: 'id',
    description: 'Budget unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiUpdateBudgetResponses()
  async updateBudget(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateBudgetDto: UpdateBudgetDto,
  ): Promise<BudgetResponseDto> {
    return this.budgetService.updateBudget(
      id,
      ctx.householdId,
      updateBudgetDto,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete a budget by ID' })
  @ApiParam({
    name: 'id',
    description: 'Budget unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiDeleteBudgetResponses()
  async deleteBudget(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.budgetService.softDeleteBudget(id, ctx.householdId);
  }
}
