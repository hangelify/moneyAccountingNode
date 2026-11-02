import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager, sql } from '@mikro-orm/core';
import { Budget } from '../../entities/budget.entity';
import { Household } from '../../entities/household.entity';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { BudgetResponseDto } from './dto/budget-response.dto';

@Injectable()
export class BudgetService {
  constructor(
    @InjectRepository(Budget)
    private readonly budgetRepository: EntityRepository<Budget>,
    private readonly em: EntityManager,
  ) {}

  /**
   * Create a new budget for a household
   * Name must be unique per household, case-insensitively (excluding
   * soft-deleted budgets). A concurrent duplicate is caught by the unique
   * index and also answered with 409.
   */
  async createBudget(
    householdId: string,
    createBudgetDto: CreateBudgetDto,
  ): Promise<BudgetResponseDto> {
    // Check if budget with same name already exists for this household (excluding soft-deleted)
    const existingBudget = await this.budgetRepository.findOne({
      household: { id: householdId },
      [sql.lower('name')]: createBudgetDto.name.toLowerCase(),
      deleted_at: null,
    });

    if (existingBudget) {
      throw new ConflictException(
        `Budget with name "${createBudgetDto.name}" already exists in this household`,
      );
    }

    const budget = new Budget();
    budget.name = createBudgetDto.name;
    budget.description = createBudgetDto.description;
    budget.household = this.em.getReference(Household, householdId);

    await this.em.persist(budget).flush();

    return {
      id: budget.id,
      name: budget.name,
      description: budget.description,
      created_at: budget.created_at,
    };
  }

  /**
   * Get a budget by ID (excluding soft-deleted budgets)
   * Only returns budget if it belongs to the household
   */
  async getBudget(id: string, householdId: string): Promise<BudgetResponseDto> {
    const budget = await this.budgetRepository.findOne(
      {
        id,
        household: { id: householdId },
        deleted_at: null, // Only get non-deleted budgets
      },
      {
        fields: ['id', 'name', 'description', 'created_at', 'deleted_at'],
      },
    );

    if (!budget) {
      throw new NotFoundException(`Budget with ID ${id} not found`);
    }

    return {
      id: budget.id,
      name: budget.name,
      description: budget.description,
      created_at: budget.created_at,
    };
  }

  /**
   * Update a budget by ID (only non-deleted budgets can be updated)
   * Only updates budget if it belongs to the household
   */
  async updateBudget(
    id: string,
    householdId: string,
    updateBudgetDto: UpdateBudgetDto,
  ): Promise<BudgetResponseDto> {
    const budget = await this.budgetRepository.findOne({
      id,
      household: { id: householdId },
      deleted_at: null, // Only update non-deleted budgets
    });

    if (!budget) {
      throw new NotFoundException(`Budget with ID ${id} not found`);
    }

    // If name is being updated, check uniqueness per household
    if (
      updateBudgetDto.name !== undefined &&
      updateBudgetDto.name !== budget.name
    ) {
      const existingBudget = await this.budgetRepository.findOne({
        household: { id: householdId },
        [sql.lower('name')]: updateBudgetDto.name.toLowerCase(),
        deleted_at: null,
      });

      // If a budget with the same name exists and it's not the current budget
      if (existingBudget && existingBudget.id !== id) {
        throw new ConflictException(
          `Budget with name "${updateBudgetDto.name}" already exists in this household`,
        );
      }
    }

    // Update only provided fields
    if (updateBudgetDto.name !== undefined) {
      budget.name = updateBudgetDto.name;
    }

    if (updateBudgetDto.description !== undefined) {
      budget.description = updateBudgetDto.description;
    }

    await this.em.persist(budget).flush();

    return {
      id: budget.id,
      name: budget.name,
      description: budget.description,
      created_at: budget.created_at,
    };
  }

  /**
   * Soft delete a budget by setting deleted_at timestamp
   * Only deletes budget if it belongs to the household
   */
  async softDeleteBudget(id: string, householdId: string): Promise<void> {
    const budget = await this.budgetRepository.findOne({
      id,
      household: { id: householdId },
      deleted_at: null, // Only soft delete non-deleted budgets
    });

    if (!budget) {
      throw new NotFoundException(`Budget with ID ${id} not found`);
    }

    // Check if budget is already soft deleted
    if (budget.deleted_at) {
      throw new BadRequestException(`Budget with ID ${id} is already deleted`);
    }

    budget.deleted_at = new Date();
    await this.em.persist(budget).flush();
  }

  /**
   * List all non-deleted budgets for a household
   */
  async listBudgets(householdId: string): Promise<BudgetResponseDto[]> {
    const budgets = await this.budgetRepository.find({
      household: { id: householdId },
      deleted_at: null,
    });
    return budgets.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      created_at: b.created_at,
    }));
  }
}
