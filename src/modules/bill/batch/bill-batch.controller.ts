import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  Sse,
  UnsupportedMediaTypeException,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { interval, map, merge, Observable, takeUntil, timer } from 'rxjs';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/types/jwt-payload.interface';
import { HouseholdMemberGuard } from '../../household/guards/household-member.guard';
import type { HouseholdContext } from '../../household/guards/household-member.guard';
import { CurrentHousehold } from '../../household/decorators/current-household.decorator';
import { UserThrottlerGuard } from '../../ai-gateway/guards/user-throttler.guard';
import { AiGatewayErrorFilter } from '../filters/ai-gateway-error.filter';
import { AiUsageLimitFilter } from '../filters/ai-usage-limit.filter';
import { AiHttpExceptionFilter } from '../filters/ai-http-exception.filter';
import { MAX_UPLOAD_BYTES, prepareReceiptImage } from '../receipt-image';
import {
  ApiBillBatchResponses,
  ApiBillEventsResponses,
  ApiParsePhotosResponses,
  ApiRetryBillResponses,
} from '../dto/api-responses.decorator';
import {
  BillBatchDisabledError,
  BillBatchDisabledFilter,
  BillBatchEnabledGuard,
} from './bill-batch-disabled';
import {
  BillBatchService,
  BillQuotaExceededException,
} from './bill-batch.service';
import { BillEventsHub } from './bill-events.hub';
import { BillBatchResponseDto } from './dto/bill-batch-response.dto';

const MAX_BATCH_FILES = 20;
/** Keeps proxies from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

/**
 * Batch photo parsing. Always registered: with BILL_BATCH_ENABLED=false the
 * services are absent and every route answers 503 (BillBatchEnabledGuard;
 * the handlers check again).
 */
@ApiTags('bills')
@Controller('households/:hid')
@UseGuards(JwtAuthGuard, HouseholdMemberGuard, BillBatchEnabledGuard)
// Method filters are tried first; none of them catches this error.
@UseFilters(BillBatchDisabledFilter)
@ApiBearerAuth('JWT-auth')
export class BillBatchController {
  constructor(
    @Optional() private readonly batches?: BillBatchService,
    @Optional() private readonly hub?: BillEventsHub,
  ) {}

  @Post('bills/parse-photos')
  @HttpCode(HttpStatus.ACCEPTED)
  // Counts the first photo; BillBatchService counts the rest.
  @UseGuards(UserThrottlerGuard)
  @UseInterceptors(
    FilesInterceptor('images', MAX_BATCH_FILES, {
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: MAX_BATCH_FILES,
        fields: 0,
      },
    }),
  )
  @UseFilters(AiGatewayErrorFilter, AiUsageLimitFilter, AiHttpExceptionFilter)
  @ApiOperation({
    summary:
      'Upload 1–20 receipt photos; each is parsed in the background into a draft or a failed bill',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          minItems: 1,
          maxItems: MAX_BATCH_FILES,
        },
      },
      required: ['images'],
    },
  })
  @ApiParsePhotosResponses()
  async parsePhotos(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillBatchResponseDto> {
    const batches = this.service();
    if (!files?.length) {
      throw new BadRequestException('At least one image is required');
    }
    // One at a time: each re-encode holds a decoded image in memory.
    const images = [];
    for (const [index, file] of files.entries()) {
      const image = await prepareFile(file.buffer, index);
      images.push({
        buffer: image.buffer,
        mediaType: image.mediaType,
        sha256: createHash('sha256').update(image.buffer).digest('hex'),
      });
    }
    return withRetryAfter(
      res,
      batches.createBatch({
        householdId: ctx.householdId,
        userId: user.id,
        images,
      }),
    );
  }

  @Get('bill-batches/:id')
  @ApiOperation({ summary: 'A photo batch and the state of each photo' })
  @ApiParam({
    name: 'id',
    description: 'Batch unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBillBatchResponses()
  getBatch(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BillBatchResponseDto> {
    return this.service().getBatch(ctx.householdId, id);
  }

  @Post('bills/:id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(UserThrottlerGuard)
  @UseFilters(AiGatewayErrorFilter, AiUsageLimitFilter, AiHttpExceptionFilter)
  @ApiOperation({
    summary: 'Parse the photo of a failed bill again in a new one-item batch',
  })
  @ApiParam({
    name: 'id',
    description: 'Failed bill unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiRetryBillResponses()
  retry(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillBatchResponseDto> {
    return withRetryAfter(
      res,
      this.service().retry(ctx.householdId, user.id, id),
    );
  }

  /**
   * Nest's @Sse cannot write comment lines, so the heartbeat is a `ping`
   * event with empty data, which clients ignore. The stream ends when the
   * access token expires, so a member removed from the household stops
   * receiving events once the token runs out.
   */
  @Sse('bills/events')
  @ApiOperation({
    summary: "Server-sent events of the household's photo batches",
  })
  @ApiBillEventsResponses()
  events(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Res({ passthrough: true }) res: Response,
  ): Observable<MessageEvent> {
    if (!this.hub) {
      throw new BillBatchDisabledError();
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    const events = this.hub.stream(ctx.householdId).pipe(
      map(
        (event): MessageEvent => ({
          type: event.type,
          data: event.data,
          id: randomUUID(),
        }),
      ),
    );
    const pings = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ type: 'ping', data: '' })),
    );
    const expiresInMs = Math.max(0, user.exp * 1000 - Date.now());
    return merge(events, pings).pipe(takeUntil(timer(expiresInMs)));
  }

  private service(): BillBatchService {
    if (!this.batches) {
      throw new BillBatchDisabledError();
    }
    return this.batches;
  }
}

/** prepareReceiptImage with the file's 0-based index in the error. */
async function prepareFile(buffer: Buffer, index: number) {
  try {
    return await prepareReceiptImage(buffer);
  } catch (err) {
    if (!(err instanceof HttpException)) throw err;
    const message = `File ${index}: ${err.message}`;
    if (err.getStatus() === Number(HttpStatus.UNSUPPORTED_MEDIA_TYPE)) {
      throw new UnsupportedMediaTypeException(message);
    }
    throw new BadRequestException(message);
  }
}

/** The quota refusal carries its wait; UserThrottlerGuard sets it likewise. */
async function withRetryAfter<T>(res: Response, call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof BillQuotaExceededException) {
      res.header('Retry-After', String(err.retryAfterSec));
    }
    throw err;
  }
}
