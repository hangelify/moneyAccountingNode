import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { CategoryLimitDto } from '../dto/category-limit.dto';

type Decorator = MethodDecorator & ClassDecorator;

const ApiUnauthorizedResponse = (): Decorator =>
  ApiResponse({ status: 401, description: 'Unauthorized' });

const ApiBadRequestResponse = (description: string): Decorator =>
  ApiResponse({ status: 400, description });

const ApiCategoryNotFoundResponse = (description: string): Decorator =>
  ApiResponse({ status: 404, description });

export const ApiListCategoryLimitsResponses = (): Decorator =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description:
        'Limits in force today (one per category), or every version with include_history=true',
      type: [CategoryLimitDto],
    }),
    ApiBadRequestResponse('include_history is not true or false'),
    ApiUnauthorizedResponse(),
  );

export const ApiCreateCategoryLimitResponses = (): Decorator =>
  applyDecorators(
    ApiResponse({
      status: 201,
      description:
        'Limit created; applies from the start of the current period',
      type: CategoryLimitDto,
    }),
    ApiBadRequestResponse(
      'Invalid amount (positive, at most 2 decimals) or period_type, or an unknown field such as currency',
    ),
    ApiCategoryNotFoundResponse('Category not found in the household'),
    ApiResponse({
      status: 409,
      description: 'The category already has a limit; use PUT',
    }),
    ApiUnauthorizedResponse(),
  );

export const ApiUpdateCategoryLimitResponses = (): Decorator =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description: 'Limit replaced; returns the new open version',
      type: CategoryLimitDto,
    }),
    ApiBadRequestResponse('Invalid amount or period_type, or malformed id'),
    ApiCategoryNotFoundResponse(
      'Category not found in the household, or it has no open limit',
    ),
    ApiUnauthorizedResponse(),
  );

export const ApiDeleteCategoryLimitResponses = (): Decorator =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description:
        'Limit closed at the end of its current period; returns the closed version',
      type: CategoryLimitDto,
    }),
    ApiBadRequestResponse('Malformed id'),
    ApiCategoryNotFoundResponse(
      'Category not found in the household, or it has no open limit',
    ),
    ApiUnauthorizedResponse(),
  );
