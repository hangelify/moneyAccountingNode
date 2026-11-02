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
  ConflictException,
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
import { BillPhotoIngestService } from './bill-photo-ingest.service';
import { BillCrudService } from './bill-crud.service';
import { BillDuplicatesService } from './bill-duplicates.service';
import { BillDashboardService } from './bill-dashboard.service';
import { SpendingBreakdownService } from './spending-breakdown.service';
import {
  ParsePhotoResponseDto,
  ParsedBillResponseDto,
} from './dto/parsed-bill-response.dto';
import { CreateBillDto } from './dto/create-bill.dto';
import { UpdateBillDto } from './dto/update-bill.dto';
import {
  BillDetailResponseDto,
  DraftImageResponseDto,
  DraftListResponseDto,
} from './dto/bill-detail-response.dto';
import { ListDraftsQueryDto } from './dto/list-drafts-query.dto';
import {
  DismissDuplicateDto,
  DuplicateSuggestionsQueryDto,
  DuplicateSuggestionsResponseDto,
  MarkDuplicateDto,
  PossibleDuplicateDto,
} from './dto/bill-duplicates.dto';
import { Currency } from '../../types/currency.enum';
import { BillListResponseDto } from './dto/bill-list-response.dto';
import {
  BillDashboardResponseDto,
  BillDashboardQueryDto,
} from './dto/bill-dashboard.dto';
import {
  SpendingBreakdownQueryDto,
  SpendingBreakdownResponseDto,
} from './dto/spending-breakdown.dto';
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
  ApiMarkDuplicateResponses,
  ApiUnmarkDuplicateResponses,
  ApiDuplicateSuggestionsResponses,
  ApiDismissDuplicateResponses,
  ApiDashboardResponses,
  ApiSpendingBreakdownResponses,
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
    private readonly photoIngest: BillPhotoIngestService,
    private readonly billCrud: BillCrudService,
    private readonly billDuplicates: BillDuplicatesService,
    private readonly billDashboard: BillDashboardService,
    private readonly spendingBreakdown: SpendingBreakdownService,
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
    const result = await this.photoIngest.ingest({
      image: image.buffer,
      mediaType: image.mediaType,
      imageSha256,
      householdId: ctx.householdId,
      userId: user.id,
    });

    if (result.kind === 'not_a_receipt') {
      throw new UnprocessableEntityException(
        aiErrorBody(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The photo is not a receipt or no items were recognized on it',
          result.requestId,
        ),
      );
    }
    if (result.kind === 'save_failed') {
      throw new UnprocessableEntityException({
        ...aiErrorBody(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The bill was recognized but the draft could not be saved; create it manually',
          result.requestId,
        ),
        parsed: result.parsed,
      });
    }

    // Answer with the draft as saved (one line per item, values
    // clamped), so a re-upload of this photo gets the same answer.
    const stored = await this.billCrud.findDraftByImageHash(
      ctx.householdId,
      imageSha256,
    );
    if (result.kind === 'existing') {
      if (!stored) {
        // Confirmed or deleted between the lookup and the read.
        throw new ConflictException('The draft of this photo is gone');
      }
      return this.duplicateResponse(ctx.householdId, stored);
    }
    if (stored) {
      return {
        ...stored.parsed,
        request_id: stored.requestId,
        duplicate: result.duplicate,
        possible_duplicates: await this.possibleDuplicates(
          ctx.householdId,
          stored.parsed,
        ),
      };
    }
    // Confirmed or deleted in the meantime.
    const saved = { ...result.parsed, draft_id: result.billId };
    return {
      ...saved,
      request_id: result.requestId,
      duplicate: result.duplicate,
      possible_duplicates: await this.possibleDuplicates(
        ctx.householdId,
        saved,
      ),
    };
  }

  private async duplicateResponse(
    householdId: string,
    draft: { parsed: ParsedBillResponseDto; requestId: string | null },
  ): Promise<ParsePhotoResponseDto> {
    return {
      ...draft.parsed,
      request_id: draft.requestId,
      duplicate: true,
      possible_duplicates: await this.possibleDuplicates(
        householdId,
        draft.parsed,
      ),
    };
  }

  /**
   * Look-alikes of a parsed draft. Never fails the request: the AI call is
   * already paid for. Without a read date or total only the receipt ids can
   * match, so the lookup narrows to those.
   */
  private async possibleDuplicates(
    householdId: string,
    draft: ParsedBillResponseDto,
  ): Promise<PossibleDuplicateDto[]> {
    const fiscalOnly = !draft.bill_date || draft.total_amount === null;
    if (
      fiscalOnly &&
      !(draft.fiscal_register_id && draft.fiscal_receipt_number)
    ) {
      return [];
    }
    try {
      return await this.billDuplicates.findCandidates(
        householdId,
        {
          // Ignored by a fiscal-only lookup.
          amount: draft.total_amount ?? 0,
          currency: (draft.currency as Currency | null) ?? null,
          bill_date: draft.bill_date ?? '',
          market_id: null,
          market_name: draft.market_name,
          fiscal_register_id: draft.fiscal_register_id,
          fiscal_receipt_number: draft.fiscal_receipt_number,
          purchase_time: draft.purchase_time,
        },
        { excludeBillId: draft.draft_id, ...(fiscalOnly && { fiscalOnly }) },
      );
    } catch (err) {
      this.log.error(
        `Looking up possible duplicates of draft ${draft.draft_id} failed`,
        err instanceof Error ? err.stack : String(err),
      );
      return [];
    }
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
      'separate series with currency null. in_household_currency converts ' +
      'every bill into the household currency at the latest saved BNM rate ' +
      'on or before its bill_date (loading up to 10 missing days per ' +
      'request) and lists bills it could not convert in unconverted; each ' +
      'bill gains household_amount.',
  })
  @ApiDashboardResponses()
  async getDashboard(
    @CurrentUser() _user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Query() query: BillDashboardQueryDto,
  ): Promise<BillDashboardResponseDto> {
    return this.billDashboard.getDashboard(ctx.householdId, query);
  }

  @Get('dashboard/spending-breakdown')
  @ApiOperation({
    summary:
      'Spending as a category → sub-category tree for a week, month, quarter, year, 5 years or custom range',
    description:
      'For a sunburst chart. Counts confirmed, not deleted bills only, one ' +
      'tree per currency (never summed across currencies; bills without a ' +
      'currency form the null series). Lines without a sub-category go to ' +
      'an "Uncategorized" bucket; deleted categories still show, marked ' +
      'archived. Totals are sums of line amounts, not of bill totals, so ' +
      'they can differ from the bill totals by a few cents. ' +
      'in_household_currency is one tree of every bill converted into the ' +
      'household currency at the latest saved BNM rate on or before its ' +
      'bill_date (loading up to 10 missing days per request); bills it ' +
      'could not convert are listed in unconverted.',
  })
  @ApiSpendingBreakdownResponses()
  async getSpendingBreakdown(
    @CurrentHousehold() ctx: HouseholdContext,
    @Query() query: SpendingBreakdownQueryDto,
  ): Promise<SpendingBreakdownResponseDto> {
    return this.spendingBreakdown.getSpendingBreakdown(ctx.householdId, query);
  }

  @Get('duplicate-suggestions')
  @ApiOperation({
    summary:
      'Pairs of confirmed bills that look like the same purchase, best match first',
  })
  @ApiDuplicateSuggestionsResponses()
  async duplicateSuggestions(
    @CurrentHousehold() ctx: HouseholdContext,
    @Query() query: DuplicateSuggestionsQueryDto,
  ): Promise<DuplicateSuggestionsResponseDto> {
    return this.billDuplicates.suggestions(ctx.householdId, query);
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

  @Post(':id/mark-duplicate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a confirmed bill as a duplicate of another bill',
  })
  @ApiParam({
    name: 'id',
    description: 'Bill unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiMarkDuplicateResponses()
  async markDuplicate(
    @CurrentUser() _user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkDuplicateDto,
  ): Promise<BillDetailResponseDto> {
    await this.billDuplicates.markDuplicate(
      id,
      ctx.householdId,
      dto.duplicate_of_id,
    );
    return this.billCrud.getBill(id, ctx.householdId);
  }

  @Post(':id/unmark-duplicate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Count a duplicate bill again' })
  @ApiParam({
    name: 'id',
    description: 'Bill unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiUnmarkDuplicateResponses()
  async unmarkDuplicate(
    @CurrentUser() _user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BillDetailResponseDto> {
    await this.billDuplicates.unmarkDuplicate(id, ctx.householdId);
    return this.billCrud.getBill(id, ctx.householdId);
  }

  @Post(':id/dismiss-duplicate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Keep both bills of a pair: stop suggesting it as a duplicate',
  })
  @ApiParam({
    name: 'id',
    description: 'Bill unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiDismissDuplicateResponses()
  async dismissDuplicate(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DismissDuplicateDto,
  ): Promise<void> {
    await this.billDuplicates.dismiss(
      id,
      ctx.householdId,
      user.id,
      dto.other_bill_id,
    );
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Update any bill (draft, confirmed or duplicate): fields, market and items; omitted fields are kept',
  })
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
  ): Promise<BillDetailResponseDto> {
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
