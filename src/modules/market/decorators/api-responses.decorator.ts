import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { MarketResponseDto } from '../dto/market-response.dto';

const ApiUnauthorized = () =>
  ApiResponse({ status: 401, description: 'Unauthorized' });
const ApiNotFound = () =>
  ApiResponse({ status: 404, description: 'Market not found' });
const ApiBadRequest = (desc?: string) =>
  ApiResponse({ status: 400, description: desc ?? 'Bad request' });
const ApiConflict = () =>
  ApiResponse({
    status: 409,
    description:
      'A market with this name (case-insensitive) already exists in the household',
  });

export const ApiCreateMarketResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 201,
      type: MarketResponseDto,
      description: 'Market created',
    }),
    ApiBadRequest(),
    ApiConflict(),
    ApiUnauthorized(),
  );

export const ApiListMarketsResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      type: [MarketResponseDto],
      description: 'Markets listed',
    }),
    ApiUnauthorized(),
  );

export const ApiGetMarketResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      type: MarketResponseDto,
      description: 'Market retrieved',
    }),
    ApiNotFound(),
    ApiUnauthorized(),
  );

export const ApiUpdateMarketResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      type: MarketResponseDto,
      description: 'Market updated',
    }),
    ApiNotFound(),
    ApiBadRequest(),
    ApiConflict(),
    ApiUnauthorized(),
  );

export const ApiDeleteMarketResponses = () =>
  applyDecorators(
    ApiResponse({ status: 204, description: 'Market soft deleted' }),
    ApiNotFound(),
    ApiUnauthorized(),
  );
