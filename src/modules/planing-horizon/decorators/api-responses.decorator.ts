import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { PlaningHorizonResponseDto } from '../dto/planing-horizon-response.dto';
import { PlaningHorizonBaseResponseDto } from '../dto/planing-horizon-base-response.dto';

/**
 * Common API responses used across planning horizon endpoints
 */
export const ApiUnauthorizedResponse = () =>
  ApiResponse({
    status: 401,
    description: 'Unauthorized',
  });

export const ApiNotFoundResponse = () =>
  ApiResponse({
    status: 404,
    description: 'Planning horizon not found',
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
      'A planning horizon with this name (case-insensitive) already exists in the budget',
  });

/**
 * Combined decorators for specific endpoints
 */
export const ApiCreatePlaningHorizonResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 201,
      description: 'Planning horizon created successfully',
      type: PlaningHorizonBaseResponseDto,
    }),
    ApiBadRequestResponse('Bad request - Budget not found or invalid input'),
    ApiConflictResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiGetPlaningHorizonResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description: 'Planning horizon retrieved successfully',
      type: PlaningHorizonResponseDto,
    }),
    ApiNotFoundResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiUpdatePlaningHorizonResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description: 'Planning horizon updated successfully',
      type: PlaningHorizonBaseResponseDto,
    }),
    ApiNotFoundResponse(),
    ApiBadRequestResponse('Bad request - Invalid input'),
    ApiConflictResponse(),
    ApiUnauthorizedResponse(),
  );

export const ApiDeletePlaningHorizonResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 204,
      description: 'Planning horizon archived successfully',
    }),
    ApiNotFoundResponse(),
    ApiBadRequestResponse('Bad request - Planning horizon already archived'),
    ApiUnauthorizedResponse(),
  );

export const ApiListPlaningHorizonsResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      description: 'Planning horizons listed successfully',
      type: [PlaningHorizonBaseResponseDto],
    }),
    ApiUnauthorizedResponse(),
  );
