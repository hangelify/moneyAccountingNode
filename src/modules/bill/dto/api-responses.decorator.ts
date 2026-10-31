import { applyDecorators } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiBadGatewayResponse,
  ApiTooManyRequestsResponse,
  ApiServiceUnavailableResponse,
  ApiUnprocessableEntityResponse,
  ApiPayloadTooLargeResponse,
  ApiUnsupportedMediaTypeResponse,
  ApiResponse,
} from '@nestjs/swagger';
import {
  AiErrorResponseDto,
  ParsePhotoResponseDto,
} from './parsed-bill-response.dto';
import { BillResponseDto } from './bill-response.dto';
import {
  BillDetailResponseDto,
  DraftImageResponseDto,
  DraftListResponseDto,
} from './bill-detail-response.dto';
import { BillDashboardResponseDto } from './bill-dashboard.dto';
import { SpendingBreakdownResponseDto } from './spending-breakdown.dto';
import { BillListResponseDto } from './bill-list-response.dto';

export function ApiParsePhotoResponses(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiOkResponse({
      type: ParsePhotoResponseDto,
      description:
        'The recognized bill, saved as a draft; request_id identifies the AI request. ' +
        'If this photo already has an open draft, that draft is returned with duplicate: true and no AI call is made.',
    }),
    // Every error of this endpoint has the AiErrorResponseDto body.
    ApiBadRequestResponse({
      type: AiErrorResponseDto,
      description:
        'Missing image, or a multipart body with more than one file or with extra fields.',
    }),
    ApiUnauthorizedResponse({
      type: AiErrorResponseDto,
      description: 'Missing or invalid JWT.',
    }),
    ApiForbiddenResponse({
      type: AiErrorResponseDto,
      description: 'The user is not a member of the household.',
    }),
    ApiPayloadTooLargeResponse({
      type: AiErrorResponseDto,
      description:
        'The file exceeds 10 MB, or the image has more than 100 megapixels.',
    }),
    ApiUnsupportedMediaTypeResponse({
      type: AiErrorResponseDto,
      description:
        'The file content is not a JPEG, PNG or WebP image (HEIC included); the client-sent Content-Type is ignored.',
    }),
    ApiUnprocessableEntityResponse({
      type: AiErrorResponseDto,
      description:
        'One of: the image could not be decoded (request_id: null); every AI provider rejected the image — retake the photo; ' +
        'the photo is not a receipt or no items were recognized on it (no draft is saved); ' +
        'or the bill was recognized but saving the draft failed — the body then also has `parsed`, shaped like the 200 response ' +
        'with an empty draft_id, so the bill can be created manually.',
    }),
    ApiTooManyRequestsResponse({
      type: AiErrorResponseDto,
      description:
        'Per-user AI limit (per minute / per 24 h) or daily AI budget exceeded.',
    }),
    ApiBadGatewayResponse({
      type: AiErrorResponseDto,
      description:
        'The AI providers failed for mixed reasons (e.g. an unusable answer); retrying may help.',
    }),
    ApiServiceUnavailableResponse({
      type: AiErrorResponseDto,
      headers: {
        'Retry-After': {
          description:
            'Seconds to wait; absent when photo recognition is not configured',
          schema: { type: 'integer' },
        },
      },
      description:
        'AI providers are rate-limited, failing or timing out; all AI call slots of this instance are busy; ' +
        'the photo could not be stored; or photo recognition is not configured (no Retry-After).',
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
      type: DraftListResponseDto,
      description: 'Draft bills listed with their items, newest first',
    }),
    ApiResponse({ status: 400, description: 'Invalid page or limit' }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
  );

export const ApiDraftImageResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      type: DraftImageResponseDto,
      description: 'Presigned URL of the draft receipt photo',
    }),
    ApiResponse({ status: 400, description: 'Invalid draft id' }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
    ApiResponse({ status: 403, description: 'Not a member of the household' }),
    ApiResponse({
      status: 404,
      description: 'No draft with an image under this id in the household',
    }),
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

export const ApiSpendingBreakdownResponses = () =>
  applyDecorators(
    ApiResponse({
      status: 200,
      type: SpendingBreakdownResponseDto,
      description:
        'Spending as a category → sub-category tree per currency. Totals ' +
        'are sums of receipt line amounts, not of bill totals, and can ' +
        'differ from them by a few cents.',
    }),
    ApiResponse({
      status: 400,
      description:
        'Invalid query: unknown period, malformed date, custom without ' +
        'from/to, from after to, or a custom range over 10 years',
    }),
    ApiResponse({ status: 401, description: 'Unauthorized' }),
    ApiResponse({
      status: 403,
      description: 'The user is not a member of the household',
    }),
  );
