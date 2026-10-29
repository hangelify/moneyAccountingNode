import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  ParseUUIDPipe,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  UseFilters,
  ParseFilePipe,
  Logger,
  UnprocessableEntityException,
  Inject,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.interface';
import { HouseholdMemberGuard } from '../household/guards/household-member.guard';
import type { HouseholdContext } from '../household/guards/household-member.guard';
import { CurrentHousehold } from '../household/decorators/current-household.decorator';
import { BillPhotoService } from './bill-photo.service';
import { BillCrudService } from './bill-crud.service';
import { BillDashboardService } from './bill-dashboard.service';
import {
  ParsePhotoResponseDto,
  ParsedBillResponseDto,
} from './dto/parsed-bill-response.dto';
import { CreateBillDto } from './dto/create-bill.dto';
import { UpdateBillDto } from './dto/update-bill.dto';
import { BillResponseDto } from './dto/bill-response.dto';
import {
  BillDetailResponseDto,
  DraftImageResponseDto,
  DraftListResponseDto,
} from './dto/bill-detail-response.dto';
import { ListDraftsQueryDto } from './dto/list-drafts-query.dto';
import { BillListResponseDto } from './dto/bill-list-response.dto';
import {
  BillDashboardResponseDto,
  BillDashboardQueryDto,
} from './dto/bill-dashboard.dto';
import {
  ApiParsePhotoResponses,
  ApiCreateBillResponses,
  ApiListBillsResponses,
  ApiGetBillResponses,
  ApiUpdateBillResponses,
  ApiDeleteBillResponses,
  ApiListDraftsResponses,
  ApiDraftImageResponses,
  ApiConfirmBillResponses,
  ApiDashboardResponses,
} from './dto/api-responses.decorator';
import { ListBillsQueryDto } from './dto/list-bills-query.dto';
import { ConfirmBillDto } from './dto/confirm-bill.dto';
import { AiGatewayErrorFilter } from './filters/ai-gateway-error.filter';
import { AiUsageLimitFilter } from './filters/ai-usage-limit.filter';
import { AiHttpExceptionFilter } from './filters/ai-http-exception.filter';
import { aiErrorBody } from './filters/ai-error-body';
import { UserThrottlerGuard } from '../ai-gateway/guards/user-throttler.guard';
import { MAX_UPLOAD_BYTES, prepareReceiptImage } from './receipt-image';
import { STORAGE_SERVICE } from '../storage/storage.service';
import type { StorageService } from '../storage/storage.service';

/** Lifetime of a presigned draft-image URL. */
const DRAFT_IMAGE_URL_TTL_SEC = 300;

@ApiTags('bills')
@Controller('households/:hid/bills')
@UseGuards(JwtAuthGuard, HouseholdMemberGuard)
@ApiBearerAuth('JWT-auth')
export class BillController {
  private readonly log = new Logger(BillController.name);

  constructor(
    private readonly billPhoto: BillPhotoService,
    private readonly billCrud: BillCrudService,
    private readonly billDashboard: BillDashboardService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  @Post('parse-photo')
  @HttpCode(HttpStatus.OK)
  // Runs after the class-level JwtAuthGuard, so it can count per user.
  @UseGuards(UserThrottlerGuard)
  // Multer stops buffering at the size limit and answers 413, so an
  // oversized upload never sits in memory whole.
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 },
    }),
  )
  // One error body for the whole endpoint: { statusCode, error, message, request_id }.
  @UseFilters(AiGatewayErrorFilter, AiUsageLimitFilter, AiHttpExceptionFilter)
  @ApiOperation({
    summary:
      'Upload a grocery receipt photo; return parsed + categorized items. Image is stored to S3; the AI request is audited.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { image: { type: 'string', format: 'binary' } },
      required: ['image'],
    },
  })
  @ApiParsePhotoResponses()
  async parsePhoto(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @UploadedFile(new ParseFilePipe()) file: Express.Multer.File,
  ): Promise<ParsePhotoResponseDto> {
    // The client's Content-Type is never trusted: the type is detected from
    // the bytes and the image re-encoded as a metadata-free JPEG.
    const image = await prepareReceiptImage(file.buffer);
    // The same photo again: answer with its open draft instead of paying
    // for another AI call.
    const imageSha256 = createHash('sha256').update(image.buffer).digest('hex');
    const existing = await this.billCrud.findDraftByImageHash(
      ctx.householdId,
      imageSha256,
    );
    if (existing) return this.duplicateResponse(existing);

    const { parsed, requestId, isReceipt } =
      await this.billPhoto.parseAndCategorize(
        image.buffer,
        image.mediaType,
        ctx.householdId,
        user.id,
      );
    if (!isReceipt) {
      throw new UnprocessableEntityException(
        aiErrorBody(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The photo is not a receipt or no items were recognized on it',
          requestId,
        ),
      );
    }

    let draft: { id: string; duplicate: boolean };
    try {
      draft = await this.billCrud.createDraftFromParsed(
        ctx.householdId,
        user.id,
        parsed,
        { imageSha256, aiRequestId: requestId },
      );
    } catch (err) {
      // The AI call is already paid for: hand back what it recognized so the
      // client can create the bill manually instead of paying again.
      this.log.error(
        `Saving the draft for AI request ${requestId} failed`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new UnprocessableEntityException({
        ...aiErrorBody(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The bill was recognized but the draft could not be saved; create it manually',
          requestId,
        ),
        parsed,
      });
    }
    // Answer with the draft as saved (one line per item, values
    // clamped), so a re-upload of this photo gets the same answer.
    const stored = await this.billCrud.findDraftByImageHash(
      ctx.householdId,
      imageSha256,
    );
    if (stored) {
      return {
        ...stored.parsed,
        request_id: stored.requestId,
        duplicate: draft.duplicate,
      };
    }
    // Confirmed or deleted in the meantime.
    return {
      ...parsed,
      draft_id: draft.id,
      request_id: requestId,
      duplicate: draft.duplicate,
    };
  }

  private duplicateResponse(draft: {
    parsed: ParsedBillResponseDto;
    requestId: string | null;
  }): ParsePhotoResponseDto {
    return { ...draft.parsed, request_id: draft.requestId, duplicate: true };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Save a confirmed parsed bill with line items' })
  @ApiCreateBillResponses()
  async createBill(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Body() dto: CreateBillDto,
  ): Promise<BillDetailResponseDto> {
    return this.billCrud.createBill(ctx.householdId, user.id, dto);
  }

  @Get()
  @ApiOperation({
    summary:
      'List confirmed bills for the current household. All query params are optional — omit for unfiltered results.',
  })
  @ApiListBillsResponses()
  async listBills(
    @CurrentUser() _user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Query() query: ListBillsQueryDto,
  ): Promise<BillListResponseDto> {
    return this.billCrud.listBills(ctx.householdId, query);
  }

  @Get('drafts')
  @ApiOperation({
    summary:
      'List draft bills of the current household with their items, newest first',
  })
  @ApiListDraftsResponses()
  async listDrafts(
    @CurrentUser() _user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Query() query: ListDraftsQueryDto,
  ): Promise<DraftListResponseDto> {
    return this.billCrud.listDrafts(ctx.householdId, query);
  }

  @Get('drafts/:id/image')
  @ApiOperation({
    summary:
      'Short-lived URL of the receipt photo a draft was parsed from, to review the draft against it',
  })
  @ApiParam({
    name: 'id',
    description: 'Draft bill unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiDraftImageResponses()
  async getDraftImage(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DraftImageResponseDto> {
    const key = await this.billCrud.getDraftImageKey(id, ctx.householdId);
    const url = await this.storage.getSignedUrl(key, DRAFT_IMAGE_URL_TTL_SEC);
    return { url, expires_in: DRAFT_IMAGE_URL_TTL_SEC };
  }

  @Get('dashboard')
  @ApiOperation({
    summary: 'Dashboard data: period totals, bill list, category stats',
    description:
      'Totals and category shares are grouped per currency (by_currency) and ' +
      'never summed across currencies. Bills without a currency form a ' +
      'separate series with currency null.',
  })
  @ApiDashboardResponses()
  async getDashboard(
    @CurrentUser() _user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Query() query: BillDashboardQueryDto,
  ): Promise<BillDashboardResponseDto> {
    return this.billDashboard.getDashboard(ctx.householdId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a bill by ID with line items' })
  @ApiParam({
    name: 'id',
    description: 'Bill unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiGetBillResponses()
  async getBill(
    @CurrentUser() _user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BillDetailResponseDto> {
    return this.billCrud.getBill(id, ctx.householdId);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a draft bill — applies user edits and saves permanently',
  })
  @ApiParam({
    name: 'id',
    description: 'Draft bill unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiConfirmBillResponses()
  async confirmBill(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmBillDto,
  ): Promise<BillDetailResponseDto> {
    return this.billCrud.confirmBill(id, ctx.householdId, user.id, dto);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update top-level bill fields' })
  @ApiParam({
    name: 'id',
    description: 'Bill unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiUpdateBillResponses()
  async updateBill(
    @CurrentUser() _user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBillDto,
  ): Promise<BillResponseDto> {
    return this.billCrud.updateBill(id, ctx.householdId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete a bill by ID' })
  @ApiParam({
    name: 'id',
    description: 'Bill unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiDeleteBillResponses()
  async deleteBill(
    @CurrentUser() _user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.billCrud.softDeleteBill(id, ctx.householdId);
  }
}
