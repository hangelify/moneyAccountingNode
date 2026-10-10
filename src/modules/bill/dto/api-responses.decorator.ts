import { applyDecorators } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiBadGatewayResponse,
  ApiTooManyRequestsResponse,
  ApiServiceUnavailableResponse,
  ApiUnprocessableEntityResponse,
  ApiResponse,
} from '@nestjs/swagger';
import { ParsedBillResponseDto } from './parsed-bill-response.dto';
import { BillResponseDto } from './bill-response.dto';
import { BillDetailResponseDto } from './bill-detail-response.dto';
import { BillDashboardResponseDto } from './bill-dashboard.dto';
import { BillListResponseDto } from './bill-list-response.dto';

export function ApiParsePhotoResponses(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiOkResponse({ type: ParsedBillResponseDto }),
    ApiBadRequestResponse({
      description: 'Invalid file (missing, wrong MIME, or exceeds 10 MB).',
    }),
    ApiUnauthorizedResponse({ description: 'Missing or invalid JWT.' }),
    ApiUnprocessableEntityResponse({
      description:
        'The bill was recognized but saving the draft failed. Body: { statusCode, message, request_id, parsed } — parsed has the shape of the 200 response with an empty draft_id, so the bill can be created manually.',
    }),
    ApiBadGatewayResponse({
      description:
        'All AI providers failed. Response body includes requestId for audit lookup.',
    }),
    ApiTooManyRequestsResponse({
      description:
        'Per-user AI limit (per minute / per 24 h) or daily AI budget exceeded.',
    }),
    ApiServiceUnavailableResponse({
      description:
        'All AI call slots of this instance are busy; see Retry-After.',
    }),
  );
}

export const ApiCreateBillResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 201,
      type: BillDetailResponseDto,
      description: 'Bill created',
    }),
    ApiResponse({
      status: 400,
      description: 'Invalid market or sub-category reference',
    }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
  );

export const ApiListBillsResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      type: BillListResponseDto,
      description: 'Paginated bill list',
    }),
    ApiResponse({
      status: 400,
      description: 'Invalid filter parameters or date_from is after date_to',
    }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
  );

export const ApiGetBillResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      type: BillDetailResponseDto,
      description: 'Bill retrieved',
    }),
    ApiResponse({ status: 404, description: 'Bill not found' }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
  );

export const ApiUpdateBillResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      type: BillResponseDto,
      description: 'Bill updated',
    }),
    ApiResponse({ status: 404, description: 'Bill not found' }),
    ApiResponse({ status: 400, description: 'Invalid market reference' }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
  );

export const ApiDeleteBillResponses = () =>
  applyDecorators(
    ApiResponse({ status: 204, description: 'Bill soft deleted' }),
    ApiResponse({ status: 404, description: 'Bill not found' }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
  );

export const ApiListDraftsResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      type: [BillResponseDto],
      description: 'Draft bills listed',
    }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
  );

export const ApiConfirmBillResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      type: BillDetailResponseDto,
      description: 'Bill confirmed',
    }),
    ApiResponse({
      status: 404,
      description: 'Draft bill not found',
    }),
    ApiResponse({
      status: 409,
      description: 'Bill is already confirmed',
    }),
    ApiResponse({
      status: 400,
      description: 'Invalid market or sub-category reference',
    }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
  );

export const ApiDashboardResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      type: BillDashboardResponseDto,
      description: 'Dashboard data retrieved',
    }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
  );
