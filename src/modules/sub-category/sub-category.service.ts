import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager } from '@mikro-orm/core';
import { SubCategory } from '../../entities/sub-category.entity';
import { Category } from '../../entities/category.entity';
import { CreateSubCategoryDto } from './dto/create-sub-category.dto';
import { BulkCreateSubCategoryDto } from './dto/bulk-create-sub-category.dto';
import { UpdateSubCategoryDto } from './dto/update-sub-category.dto';
import { SubCategoryResponseDto } from './dto/sub-category-response.dto';

@Injectable()
export class SubCategoryService {
  constructor(
    @InjectRepository(SubCategory)
    private readonly subCategoryRepository: EntityRepository<SubCategory>,
    @InjectRepository(Category)
    private readonly categoryRepository: EntityRepository<Category>,
    private readonly em: EntityManager,
  ) {}

  /**
   * Verify that a category belongs to the household
   */
  private async verifyCategoryBelongsToHousehold(
    categoryId: string,
    householdId: string,
  ): Promise<Category> {
    const category = await this.categoryRepository.findOne({
      id: categoryId,
      household: { id: householdId },
      deleted_at: null,
    });

    if (!category) {
      throw new NotFoundException(`Category with ID ${categoryId} not found`);
    }

    return category;
  }

  /**
   * Create a new sub-category and link it to a category
   * Category must belong to the household
   */
  async createSubCategory(
    householdId: string,
    createSubCategoryDto: CreateSubCategoryDto,
  ): Promise<SubCategoryResponseDto> {
    // Verify that the category exists and belongs to the household
    const category = await this.verifyCategoryBelongsToHousehold(
      createSubCategoryDto.category_id,
      householdId,
    );

    const subCategory = new SubCategory();
    subCategory.name = createSubCategoryDto.name;
    subCategory.description = createSubCategoryDto.description;
    subCategory.category = category;

    await this.em.persist(subCategory).flush();

    return {
      id: subCategory.id,
      name: subCategory.name,
      description: subCategory.description,
      category_id: subCategory.category.id,
      category_name: subCategory.category.name,
      created_at: subCategory.created_at,
      updated_at: subCategory.updated_at,
    };
  }

  /**
   * Bulk create sub-categories for a category
   * All sub-categories will be related to one category
   */
  async bulkCreateSubCategories(
    householdId: string,
    bulkCreateSubCategoryDto: BulkCreateSubCategoryDto,
  ): Promise<SubCategoryResponseDto[]> {
    // Verify that the category exists and belongs to the household
    const category = await this.verifyCategoryBelongsToHousehold(
      bulkCreateSubCategoryDto.category_id,
      householdId,
    );

    const subCategories: SubCategory[] = [];

    for (const subCategoryItem of bulkCreateSubCategoryDto.sub_categories) {
      const subCategory = new SubCategory();
      subCategory.name = subCategoryItem.name;
      subCategory.description = subCategoryItem.description;
      subCategory.category = category;
      subCategories.push(subCategory);
    }

    await this.em.persist(subCategories).flush();

    return subCategories.map((subCategory) => ({
      id: subCategory.id,
      name: subCategory.name,
      description: subCategory.description,
      category_id: subCategory.category.id,
      category_name: subCategory.category.name,
      created_at: subCategory.created_at,
      updated_at: subCategory.updated_at,
    }));
  }

  /**
   * Get a sub-category by ID
   * Only returns sub-category if it belongs to the household through category
   */
  async getSubCategory(
    id: string,
    householdId: string,
  ): Promise<SubCategoryResponseDto> {
    const subCategory = await this.subCategoryRepository.findOne(
      {
        id,
        category: { household: { id: householdId }, deleted_at: null },
        deleted_at: null,
      },
      {
        populate: ['category'],
      },
    );

    if (!subCategory) {
      throw new NotFoundException(`Sub-category with ID ${id} not found`);
    }

    return {
      id: subCategory.id,
      name: subCategory.name,
      description: subCategory.description,
      category_id: subCategory.category.id,
      category_name: subCategory.category.name,
      created_at: subCategory.created_at,
      updated_at: subCategory.updated_at,
    };
  }

  /**
   * Get all sub-categories for a household
   * Returns sub-categories that belong to categories that belong to the household
   */
  async getAllUserSubCategories(
    householdId: string,
  ): Promise<SubCategoryResponseDto[]> {
    const subCategories = await this.subCategoryRepository.find(
      {
        category: { household: { id: householdId }, deleted_at: null },
        deleted_at: null,
      },
      {
        populate: ['category'],
      },
    );

    return subCategories.map((subCategory) => ({
      id: subCategory.id,
      name: subCategory.name,
      description: subCategory.description,
      category_id: subCategory.category.id,
      category_name: subCategory.category.name,
      created_at: subCategory.created_at,
      updated_at: subCategory.updated_at,
    }));
  }

  /**
   * Update a sub-category by ID
   * Only updates sub-category if it belongs to the household through category
   */
  async updateSubCategory(
    id: string,
    householdId: string,
    updateSubCategoryDto: UpdateSubCategoryDto,
  ): Promise<SubCategoryResponseDto> {
    const subCategory = await this.subCategoryRepository.findOne(
      {
        id,
        category: { household: { id: householdId }, deleted_at: null },
        deleted_at: null,
      },
      {
        populate: ['category'],
      },
    );

    if (!subCategory) {
      throw new NotFoundException(`Sub-category with ID ${id} not found`);
    }

    // Update only provided fields
    if (updateSubCategoryDto.name !== undefined) {
      subCategory.name = updateSubCategoryDto.name;
    }

    if (updateSubCategoryDto.description !== undefined) {
      subCategory.description = updateSubCategoryDto.description;
    }

    await this.em.persist(subCategory).flush();

    return {
      id: subCategory.id,
      name: subCategory.name,
      description: subCategory.description,
      category_id: subCategory.category.id,
      category_name: subCategory.category.name,
      created_at: subCategory.created_at,
      updated_at: subCategory.updated_at,
    };
  }

  /**
   * Soft delete a sub-category by setting deleted_at timestamp
   * Only deletes sub-category if it belongs to the household through category
   */
  async softDeleteSubCategory(id: string, householdId: string): Promise<void> {
    const subCategory = await this.subCategoryRepository.findOne(
      {
        id,
        category: { household: { id: householdId }, deleted_at: null },
        deleted_at: null,
      },
      {
        populate: ['category'],
      },
    );

    if (!subCategory) {
      throw new NotFoundException(`Sub-category with ID ${id} not found`);
    }

    // Check if sub-category is already soft deleted
    if (subCategory.deleted_at) {
      throw new BadRequestException(
        `Sub-category with ID ${id} is already deleted`,
      );
    }

    subCategory.deleted_at = new Date();
    await this.em.persist(subCategory).flush();
  }
}
