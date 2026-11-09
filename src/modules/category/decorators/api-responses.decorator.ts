import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { CategoryResponseDto } from '../dto/category-response.dto';
import { CategoryBaseResponseDto } from '../dto/category-base-response.dto';
import { RecentCategoryDto } from '../dto/recent-categories.dto';

/**
 * Common API responses used across category endpoints
 */
export const ApiUnauthorizedResponse = () =>
  ApiResponse({
    status: 401,
    description: 'Unauthorized',
  });

export const ApiNotFoundResponse = () =>
  ApiResponse({
    status: 404,
    description: 'Category not found',
  });

export const ApiBadRequestResponse = (description?: string) =>
  ApiResponse({
    status: 400,
    description: description || 'Bad request - Invalid input',
  });

export const ApiConflictResponse = () =>
  ApiResponse({
    status: 409,
    description:
      'A category with this name (case-insensitive) already exists in the household',
  });

/**
 * Combined decorators for specific endpoints
 */
export const ApiCreateCategoryResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 201,
      description: 'Category created successfully',
      type: CategoryResponseDto,
    }),
    ApiBadRequestResponse(
      'Bad request - Invalid input or planning horizon not found',
    ),
    ApiConflictResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiBulkCreateCategoryResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 201,
      description: 'Categories created successfully',
      type: [CategoryResponseDto],
    }),
    ApiBadRequestResponse(
      'Bad request - Invalid input or planning horizon not found, or duplicate names within the request',
    ),
    ApiConflictResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiGetCategoryResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description: 'Category retrieved successfully',
      type: CategoryResponseDto,
    }),
    ApiNotFoundResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiGetAllCategoriesResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description: 'Categories retrieved successfully',
      type: [CategoryBaseResponseDto],
    }),
    ApiUnauthorizedResponse(),
  );

export const ApiRecentCategoriesResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description:
        "Category and sub-category pairs of the household's confirmed bills of the last 90 days, newest use first; deleted ones left out",
      type: [RecentCategoryDto],
    }),
    ApiResponse({ status: 400, description: 'limit is not 1..50' }),
    ApiUnauthorizedResponse(),
  );

export const ApiUpdateCategoryResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description: 'Category updated successfully',
      type: CategoryResponseDto,
    }),
    ApiNotFoundResponse(),
    ApiBadRequestResponse('Bad request - Invalid input'),
    ApiConflictResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiDeleteCategoryResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 204,
      description: 'Category deleted successfully',
    }),
    ApiNotFoundResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiSeedDefaultCategoriesResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 204,
      description: 'Default categories seeded (missing ones created)',
    }),
    ApiUnauthorizedResponse(),
    ApiResponse({
      status: 403,
      description:
        'Caller is not a member of the household (or the household ID is malformed)',
    }),
  );
