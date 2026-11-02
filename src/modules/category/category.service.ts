import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager } from '@mikro-orm/core';
import { Category } from '../../entities/category.entity';
import { PlaningHorizon } from '../../entities/planing-horizon.entity';
import { Household } from '../../entities/household.entity';
import { CreateCategoryDto } from './dto/create-category.dto';
import { BulkCreateCategoryDto } from './dto/bulk-create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CategoryResponseDto } from './dto/category-response.dto';
import { CategoryBaseResponseDto } from './dto/category-base-response.dto';
import { assertUniqueNames } from '../../common/utils/unique-names.util';

@Injectable()
export class CategoryService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: EntityRepository<Category>,
    @InjectRepository(PlaningHorizon)
    private readonly planingHorizonRepository: EntityRepository<PlaningHorizon>,
    private readonly em: EntityManager,
  ) {}

  /**
   * Create a new category and link it to a planning horizon
   * Planning horizon must belong to the household through budget
   */
  async createCategory(
    householdId: string,
    createCategoryDto: CreateCategoryDto,
  ): Promise<CategoryResponseDto> {
    // Verify that the planning horizon exists and belongs to the household
    const planingHorizon = await this.planingHorizonRepository.findOne({
      id: createCategoryDto.planing_horizon_id,
      budget: { household: { id: householdId }, deleted_at: null },
      is_archived: false,
      deleted_at: null,
    });

    if (!planingHorizon) {
      throw new NotFoundException(
        `Planning horizon with ID ${createCategoryDto.planing_horizon_id} not found or does not belong to this household`,
      );
    }

    const category = new Category();
    category.name = createCategoryDto.name;
    category.description = createCategoryDto.description;
    category.household = this.em.getReference(Household, householdId);

    // Link category to planning horizon
    category.planingHorizons.add(planingHorizon);

    await this.em.persist(category).flush();

    return {
      id: category.id,
      name: category.name,
      description: category.description,
      created_at: category.created_at,
      updated_at: category.updated_at,
    };
  }

  /**
   * Bulk create categories for a planning horizon
   * This is the only way to create categories (as per requirements)
   */
  async bulkCreateCategories(
    householdId: string,
    bulkCreateCategoryDto: BulkCreateCategoryDto,
  ): Promise<CategoryResponseDto[]> {
    // Verify that the planning horizon exists and belongs to the household
    const planingHorizon = await this.planingHorizonRepository.findOne({
      id: bulkCreateCategoryDto.planing_horizon_id,
      budget: { household: { id: householdId }, deleted_at: null },
      is_archived: false,
      deleted_at: null,
    });

    if (!planingHorizon) {
      throw new NotFoundException(
        `Planning horizon with ID ${bulkCreateCategoryDto.planing_horizon_id} not found or does not belong to this household`,
      );
    }

    assertUniqueNames(bulkCreateCategoryDto.categories.map((c) => c.name));

    const categories: Category[] = [];

    for (const categoryItem of bulkCreateCategoryDto.categories) {
      const category = new Category();
      category.name = categoryItem.name;
      category.description = categoryItem.description;
      category.household = this.em.getReference(Household, householdId);
      category.planingHorizons.add(planingHorizon);
      categories.push(category);
    }

    await this.em.persist(categories).flush();

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      description: category.description,
      created_at: category.created_at,
      updated_at: category.updated_at,
    }));
  }

  /**
   * Get a category by ID
   * Only returns category if it belongs to the household
   * Includes sub-categories in the response
   */
  async getCategory(
    id: string,
    householdId: string,
  ): Promise<CategoryResponseDto> {
    const category = await this.categoryRepository.findOne(
      { id, household: { id: householdId }, deleted_at: null },
      { populate: ['subCategories'] },
    );
    if (!category) {
      throw new NotFoundException(`Category with ID ${id} not found`);
    }

    const subCategories = category.subCategories
      .getItems()
      .filter((sc) => !sc.deleted_at)
      .map((sc) => ({
        id: sc.id,
        name: sc.name,
        description: sc.description,
        category_id: category.id,
        category_name: category.name,
        created_at: sc.created_at,
        updated_at: sc.updated_at,
      }));

    return {
      id: category.id,
      name: category.name,
      description: category.description,
      created_at: category.created_at,
      updated_at: category.updated_at,
      sub_categories: subCategories,
    };
  }

  /**
   * Get all categories for a household
   * Returns categories that directly belong to the household
   * Does not include sub-categories in the response
   */
  async getAllUserCategories(
    householdId: string,
  ): Promise<CategoryBaseResponseDto[]> {
    const categories = await this.categoryRepository.find(
      { household: { id: householdId }, deleted_at: null },
      { orderBy: { name: 'asc' } },
    );
    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
  }

  /**
   * Update a category by ID
   * Only updates category if it belongs to the household
   */
  async updateCategory(
    id: string,
    householdId: string,
    updateCategoryDto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    const category = await this.categoryRepository.findOne({
      id,
      household: { id: householdId },
      deleted_at: null,
    });
    if (!category) {
      throw new NotFoundException(`Category with ID ${id} not found`);
    }

    if (updateCategoryDto.name !== undefined)
      category.name = updateCategoryDto.name;
    if (updateCategoryDto.description !== undefined)
      category.description = updateCategoryDto.description;

    await this.em.persist(category).flush();

    return {
      id: category.id,
      name: category.name,
      description: category.description,
      created_at: category.created_at,
      updated_at: category.updated_at,
    };
  }

  /**
   * Soft delete a category by setting deleted_at timestamp
   * Only deletes category if it belongs to the household
   * Its live sub-categories are soft deleted in the same flush
   */
  async deleteCategory(id: string, householdId: string): Promise<void> {
    const category = await this.categoryRepository.findOne(
      { id, household: { id: householdId }, deleted_at: null },
      { populate: ['subCategories'] },
    );
    if (!category) {
      throw new NotFoundException(`Category with ID ${id} not found`);
    }
    if (category.deleted_at) {
      throw new BadRequestException(
        `Category with ID ${id} is already deleted`,
      );
    }
    const now = new Date();
    category.deleted_at = now;
    for (const sc of category.subCategories) {
      sc.deleted_at ??= now;
    }
    await this.em.persist(category).flush();
  }
}
