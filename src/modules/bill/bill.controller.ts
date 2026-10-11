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
} from '@nestjs/common';
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
import { ParsePhotoResponseDto } from './dto/parsed-bill-response.dto';
import { CreateBillDto } from './dto/create-bill.dto';
import { UpdateBillDto } from './dto/update-bill.dto';
import { BillResponseDto } from './dto/bill-response.dto';
import { BillDetailResponseDto } from './dto/bill-detail-response.dto';
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
    const { parsed, requestId } = await this.billPhoto.parseAndCategorize(
      image.buffer,
      image.mediaType,
      ctx.householdId,
      user.id,
    );
    let draftId: string;
    try {
      draftId = await this.billCrud.createDraftFromParsed(
        ctx.householdId,
        user.id,
        parsed,
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
    return { ...parsed, draft_id: draftId, request_id: requestId };
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
  @ApiOperation({ summary: 'List all draft bills for the current household' })
  @ApiListDraftsResponses()
  async listDrafts(
    @CurrentUser() _user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
  ): Promise<BillResponseDto[]> {
    return this.billCrud.listDrafts(ctx.householdId);
  }

  @Get('dashboard')
  @ApiOperation({
    summary: 'Dashboard data: period totals, bill list, category stats',
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
