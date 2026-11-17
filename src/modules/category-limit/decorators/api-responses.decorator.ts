import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { CategoryLimitDto } from '../dto/category-limit.dto';
import {
  LimitReportCategoryDto,
  LimitReportDto,
} from '../dto/limit-report.dto';

type Decorator = MethodDecorator & ClassDecorator;

const ApiUnauthorizedResponse = (): Decorator =>
  ApiResponse({ status: 401, description: 'Unauthorized' });

const ApiForbiddenResponse = (): Decorator =>
  ApiResponse({ status: 403, description: 'Not a member of the household' });

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
    ApiForbiddenResponse(),
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
    ApiForbiddenResponse(),
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
    ApiForbiddenResponse(),
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
    ApiForbiddenResponse(),
  );

export const ApiLimitReportResponses = (): Decorator =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description:
        'Categories with a limit in the period: limit with carry-over, spent, remaining; totals and spending outside the limits',
      type: LimitReportDto,
    }),
    ApiBadRequestResponse(
      'Missing or unknown period_type, or date is not a YYYY-MM-DD calendar day',
    ),
    ApiUnauthorizedResponse(),
    ApiForbiddenResponse(),
  );

export const ApiSetCarryOverResponses = (): Decorator =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description:
        "Mark set or removed (idempotent); returns the category's report row of the next period, or of the marked period when the next one has no limit of the type",
      type: LimitReportCategoryDto,
    }),
    ApiBadRequestResponse(
      'Invalid body or malformed id; period_start is not the start of a period of the type, or is a future period',
    ),
    ApiCategoryNotFoundResponse(
      'Category not found in the household, or it has no limit of the type in that period',
    ),
    ApiUnauthorizedResponse(),
    ApiForbiddenResponse(),
  );
