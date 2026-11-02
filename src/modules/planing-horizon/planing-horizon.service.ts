import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager, sql } from '@mikro-orm/core';
import { PlaningHorizon } from '../../entities/planing-horizon.entity';
import { Budget } from '../../entities/budget.entity';
import { CreatePlaningHorizonDto } from './dto/create-planing-horizon.dto';
import { UpdatePlaningHorizonDto } from './dto/update-planing-horizon.dto';
import { PlaningHorizonResponseDto } from './dto/planing-horizon-response.dto';
import { PlaningHorizonBaseResponseDto } from './dto/planing-horizon-base-response.dto';
import { CategoryResponseDto } from '../category/dto/category-response.dto';

@Injectable()
export class PlaningHorizonService {
  constructor(
    @InjectRepository(PlaningHorizon)
    private readonly planingHorizonRepository: EntityRepository<PlaningHorizon>,
    @InjectRepository(Budget)
    private readonly budgetRepository: EntityRepository<Budget>,
    private readonly em: EntityManager,
  ) {}

  /**
   * Create a new planning horizon for a household
   * Name must be unique per budget, case-insensitively (excluding archived planning horizons)
   * Budget must belong to the household
   */
  async createPlaningHorizon(
    householdId: string,
    createPlaningHorizonDto: CreatePlaningHorizonDto,
  ): Promise<PlaningHorizonBaseResponseDto> {
    // Verify that the budget exists and belongs to the household
    const budget = await this.budgetRepository.findOne({
      id: createPlaningHorizonDto.budget_id,
      household: { id: householdId },
      deleted_at: null,
    });

    if (!budget) {
      throw new NotFoundException(
        `Budget with ID ${createPlaningHorizonDto.budget_id} not found or does not belong to this household`,
      );
    }

    // Names are unique per budget, case-insensitively, among active horizons
    // (the unique index catches a concurrent duplicate as 409 too)
    const existingPlaningHorizon = await this.planingHorizonRepository.findOne({
      budget,
      [sql.lower('name')]: createPlaningHorizonDto.name.toLowerCase(),
      is_archived: false,
      deleted_at: null,
    });

    if (existingPlaningHorizon) {
      throw new ConflictException(
        `Planning horizon with name "${createPlaningHorizonDto.name}" already exists in this budget`,
      );
    }

    const planingHorizon = new PlaningHorizon();
    planingHorizon.name = createPlaningHorizonDto.name;
    planingHorizon.description = createPlaningHorizonDto.description;
    planingHorizon.amount = createPlaningHorizonDto.amount;
    planingHorizon.currency = createPlaningHorizonDto.currency;
    planingHorizon.period_type = createPlaningHorizonDto.period_type;
    planingHorizon.budget = budget;
    planingHorizon.is_archived = false;

    await this.em.persist(planingHorizon).flush();

    return {
      id: planingHorizon.id,
      name: planingHorizon.name,
      description: planingHorizon.description,
      amount: Number(planingHorizon.amount),
      currency: planingHorizon.currency,
      period_type: planingHorizon.period_type,
      created_at: planingHorizon.created_at,
      updated_at: planingHorizon.updated_at,
      is_archived: planingHorizon.is_archived,
      budget_id: planingHorizon.budget.id,
    };
  }

  /**
   * Get a planning horizon by ID (excluding archived and soft-deleted)
   * Only returns planning horizon if it belongs to the household through budget
   * Includes categories linked to this planning horizon
   */
  async getPlaningHorizon(
    id: string,
    householdId: string,
  ): Promise<PlaningHorizonResponseDto> {
    const planingHorizon = await this.planingHorizonRepository.findOne(
      {
        id,
        budget: { household: { id: householdId }, deleted_at: null },
        is_archived: false,
        deleted_at: null,
      },
      {
        populate: ['budget', 'categories'],
        fields: [
          'id',
          'name',
          'description',
          'amount',
          'currency',
          'period_type',
          'created_at',
          'updated_at',
          'is_archived',
          'deleted_at',
          'budget.id',
        ],
      },
    );

    if (!planingHorizon) {
      throw new NotFoundException(`Planning horizon with ID ${id} not found`);
    }

    // Map categories to CategoryResponseDto format
    const categories: CategoryResponseDto[] = [];
    if (planingHorizon.categories.isInitialized()) {
      for (const category of planingHorizon.categories) {
        if (!category.deleted_at) {
          categories.push({
            id: category.id,
            name: category.name,
            description: category.description,
            created_at: category.created_at,
            updated_at: category.updated_at,
          });
        }
      }
    }

    return {
      id: planingHorizon.id,
      name: planingHorizon.name,
      description: planingHorizon.description,
      amount: Number(planingHorizon.amount),
      currency: planingHorizon.currency,
      period_type: planingHorizon.period_type,
      created_at: planingHorizon.created_at,
      updated_at: planingHorizon.updated_at,
      is_archived: planingHorizon.is_archived,
      budget_id: planingHorizon.budget.id,
      categories,
    };
  }

  /**
   * Update a planning horizon by ID (only non-archived planning horizons can be updated)
   * Only updates planning horizon if it belongs to the household through budget
   */
  async updatePlaningHorizon(
    id: string,
    householdId: string,
    updatePlaningHorizonDto: UpdatePlaningHorizonDto,
  ): Promise<PlaningHorizonBaseResponseDto> {
    const planingHorizon = await this.planingHorizonRepository.findOne(
      {
        id,
        budget: { household: { id: householdId }, deleted_at: null },
        is_archived: false,
        deleted_at: null,
      },
      { populate: ['budget'] },
    );

    if (!planingHorizon) {
      throw new NotFoundException(`Planning horizon with ID ${id} not found`);
    }

    // If name is being updated, check uniqueness per budget
    if (
      updatePlaningHorizonDto.name !== undefined &&
      updatePlaningHorizonDto.name !== planingHorizon.name
    ) {
      const existingPlaningHorizon =
        await this.planingHorizonRepository.findOne({
          budget: planingHorizon.budget,
          [sql.lower('name')]: updatePlaningHorizonDto.name.toLowerCase(),
          is_archived: false,
          deleted_at: null,
        });

      // If a planning horizon with the same name exists and it's not the current one
      if (existingPlaningHorizon && existingPlaningHorizon.id !== id) {
        throw new ConflictException(
          `Planning horizon with name "${updatePlaningHorizonDto.name}" already exists in this budget`,
        );
      }
    }

    // Update only provided fields
    if (updatePlaningHorizonDto.name !== undefined) {
      planingHorizon.name = updatePlaningHorizonDto.name;
    }

    if (updatePlaningHorizonDto.description !== undefined) {
      planingHorizon.description = updatePlaningHorizonDto.description;
    }

    if (updatePlaningHorizonDto.amount !== undefined) {
      planingHorizon.amount = updatePlaningHorizonDto.amount;
    }

    if (updatePlaningHorizonDto.currency !== undefined) {
      planingHorizon.currency = updatePlaningHorizonDto.currency;
    }

    if (updatePlaningHorizonDto.period_type !== undefined) {
      planingHorizon.period_type = updatePlaningHorizonDto.period_type;
    }

    await this.em.persist(planingHorizon).flush();

    return {
      id: planingHorizon.id,
      name: planingHorizon.name,
      description: planingHorizon.description,
      amount: Number(planingHorizon.amount),
      currency: planingHorizon.currency,
      period_type: planingHorizon.period_type,
      created_at: planingHorizon.created_at,
      updated_at: planingHorizon.updated_at,
      is_archived: planingHorizon.is_archived,
      budget_id: planingHorizon.budget.id,
    };
  }

  /**
   * Soft delete a planning horizon by setting is_archived to true
   * Only archives planning horizon if it belongs to the household through budget
   */
  async softDeletePlaningHorizon(
    id: string,
    householdId: string,
  ): Promise<void> {
    const planingHorizon = await this.planingHorizonRepository.findOne({
      id,
      budget: { household: { id: householdId }, deleted_at: null },
      is_archived: false,
      deleted_at: null,
    });

    if (!planingHorizon) {
      throw new NotFoundException(`Planning horizon with ID ${id} not found`);
    }

    // Check if planning horizon is already archived
    if (planingHorizon.is_archived) {
      throw new BadRequestException(
        `Planning horizon with ID ${id} is already archived`,
      );
    }

    planingHorizon.is_archived = true;
    await this.em.persist(planingHorizon).flush();
  }

  /**
   * List all planning horizons for a household
   * Returns only non-archived, non-deleted planning horizons that belong to the household through their budget
   */
  async listPlaningHorizons(
    householdId: string,
  ): Promise<PlaningHorizonBaseResponseDto[]> {
    const horizons = await this.planingHorizonRepository.find(
      {
        is_archived: false,
        deleted_at: null,
        budget: { household: { id: householdId }, deleted_at: null },
      },
      { populate: ['budget'] },
    );
    return horizons.map((ph) => ({
      id: ph.id,
      name: ph.name,
      description: ph.description,
      amount: Number(ph.amount),
      currency: ph.currency,
      period_type: ph.period_type,
      created_at: ph.created_at,
      updated_at: ph.updated_at,
      is_archived: ph.is_archived,
      budget_id: ph.budget.id,
    }));
  }
}
