import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { SubCategoryResponseDto } from '../dto/sub-category-response.dto';

/**
 * Common API responses used across sub-category endpoints
 */
export const ApiUnauthorizedResponse = () =>
  ApiResponse({
    status: 401,
    description: 'Unauthorized',
  });

export const ApiNotFoundResponse = () =>
  ApiResponse({
    status: 404,
    description: 'Sub-category not found',
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
      'A sub-category with this name (case-insensitive) already exists in the category',
  });

/**
 * Combined decorators for specific endpoints
 */
export const ApiCreateSubCategoryResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 201,
      description: 'Sub-category created successfully',
      type: SubCategoryResponseDto,
    }),
    ApiBadRequestResponse('Bad request - Invalid input or category not found'),
    ApiConflictResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiBulkCreateSubCategoryResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 201,
      description: 'Sub-categories created successfully',
      type: [SubCategoryResponseDto],
    }),
    ApiBadRequestResponse(
      'Bad request - Invalid input or category not found, or duplicate names within the request',
    ),
    ApiConflictResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiGetSubCategoryResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description: 'Sub-category retrieved successfully',
      type: SubCategoryResponseDto,
    }),
    ApiNotFoundResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiGetAllSubCategoriesResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description: 'Sub-categories retrieved successfully',
      type: [SubCategoryResponseDto],
    }),
    ApiUnauthorizedResponse(),
  );

export const ApiUpdateSubCategoryResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description: 'Sub-category updated successfully',
      type: SubCategoryResponseDto,
    }),
    ApiNotFoundResponse(),
    ApiBadRequestResponse('Bad request - Invalid input'),
    ApiConflictResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiDeleteSubCategoryResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 204,
      description: 'Sub-category deleted successfully',
    }),
    ApiNotFoundResponse(),
    ApiUnauthorizedResponse(),
  );
