import { Test } from '@nestjs/testing';
import {
  Logger,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import { APP_FILTER } from '@nestjs/core';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { BillController } from './bill.controller';
import { BillPhotoService } from './bill-photo.service';
import { BillCrudService } from './bill-crud.service';
import { BillDashboardService } from './bill-dashboard.service';
import { BillDashboardQueryDto } from './dto/bill-dashboard.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HouseholdMemberGuard } from '../household/guards/household-member.guard';
import { AiGatewayErrorFilter } from './filters/ai-gateway-error.filter';
import { AiUsageLimitFilter } from './filters/ai-usage-limit.filter';
import { UserThrottlerGuard } from '../ai-gateway/guards/user-throttler.guard';
import { STORAGE_SERVICE } from '../storage/storage.service';

function makeImage(format: 'png' | 'jpeg'): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 30, channels: 3, background: '#fff' },
  })
    .toFormat(format)
    .toBuffer();
}

describe('BillController', () => {
  let controller: BillController;
  let billDashboardMock: { getDashboard: jest.Mock };
  const parseAndCategorize = jest.fn();
  const billCrudMock = {
    createBill: jest.fn(),
    listBills: jest.fn(),
    getBill: jest.fn(),
    updateBill: jest.fn(),
    softDeleteBill: jest.fn(),
    createDraftFromParsed: jest.fn(),
    findDraftByImageHash: jest.fn(),
    getDraftImageKey: jest.fn(),
    listDrafts: jest.fn(),
    confirmBill: jest.fn(),
  };

  const getSignedUrl = jest.fn();

  beforeEach(async () => {
    parseAndCategorize.mockReset();
    getSignedUrl.mockReset();
    Object.values(billCrudMock).forEach((fn) => fn.mockReset());
    billDashboardMock?.getDashboard?.mockReset?.();
    const mod = await Test.createTestingModule({
      controllers: [BillController],
      providers: [
        { provide: BillPhotoService, useValue: { parseAndCategorize } },
        { provide: BillCrudService, useValue: billCrudMock },
        {
          provide: BillDashboardService,
          useValue: { getDashboard: jest.fn() },
        },
        { provide: STORAGE_SERVICE, useValue: { getSignedUrl } },
        { provide: APP_FILTER, useClass: AiGatewayErrorFilter },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HouseholdMemberGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(BillController);
    billDashboardMock = mod.get(BillDashboardService);
    billDashboardMock.getDashboard = jest.fn();
  });

  it('forwards the normalized JPEG + user id to BillPhotoService and returns the saved draft', async () => {
    const dto = {
      market_name: null,
      bill_date: null,
      currency: null,
      total_amount: null,
      items: [{ name: 'BREAD' }],
    };
    const draftId = 'draft-uuid-001';
    parseAndCategorize.mockResolvedValue({
      parsed: dto,
      requestId: 'req-1',
      isReceipt: true,
    });
    const saved = { ...dto, draft_id: draftId, items: [{ name: 'BREAD 1' }] };
    billCrudMock.findDraftByImageHash
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ parsed: saved, requestId: 'req-1' });
    billCrudMock.createDraftFromParsed.mockResolvedValue({
      id: draftId,
      duplicate: false,
    });
    const fakeFile = {
      buffer: await makeImage('png'),
      mimetype: 'image/png',
    } as Express.Multer.File;
    const res = await controller.parsePhoto(
      { id: 'user-xyz' } as never,
      { householdId: 'hh-1', role: 'owner' } as never,
      fakeFile,
    );
    expect(parseAndCategorize).toHaveBeenCalledWith(
      expect.any(Buffer),
      'image/jpeg',
      'hh-1',
      'user-xyz',
    );
    const [[sent]] = parseAndCategorize.mock.calls as [[Buffer]];
    expect((await sharp(sent).metadata()).format).toBe('jpeg');
    const imageSha256 = createHash('sha256').update(sent).digest('hex');
    expect(billCrudMock.findDraftByImageHash).toHaveBeenCalledWith(
      'hh-1',
      imageSha256,
    );
    expect(billCrudMock.createDraftFromParsed).toHaveBeenCalledWith(
      'hh-1',
      'user-xyz',
      dto,
      { imageSha256, aiRequestId: 'req-1' },
    );
    expect(res).toEqual({
      ...saved,
      request_id: 'req-1',
      duplicate: false,
    });
  });

  it('answers 422 with the request id and parsed bill when the draft cannot be saved', async () => {
    const dto = {
      draft_id: '',
      market_name: 'Lidl',
      bill_date: null,
      currency: null,
      total_amount: 1,
      items: [{ name: 'BREAD' }],
    };
    parseAndCategorize.mockResolvedValue({
      parsed: dto,
      requestId: 'req-9',
      isReceipt: true,
    });
    billCrudMock.findDraftByImageHash.mockResolvedValue(null);
    billCrudMock.createDraftFromParsed.mockRejectedValue(
      new Error('numeric field overflow'),
    );
    const logSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const err: unknown = await controller
      .parsePhoto(
        { id: 'user-xyz' } as never,
        { householdId: 'hh-1', role: 'owner' } as never,
        { buffer: await makeImage('png'), mimetype: 'image/png' } as never,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toEqual({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: expect.any(String) as string,
      request_id: 'req-9',
      parsed: dto,
    });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  describe('re-upload of the same photo', () => {
    const stored = {
      draft_id: 'draft-old',
      market_name: 'Lidl',
      bill_date: '2026-05-07',
      currency: 'EUR',
      total_amount: 2.4,
      items: [{ name: 'BREAD' }],
    };

    it('returns the open draft of the same image without calling the AI', async () => {
      billCrudMock.findDraftByImageHash.mockResolvedValue({
        parsed: stored,
        requestId: 'req-old',
      });

      const res = await controller.parsePhoto(
        { id: 'user-xyz' } as never,
        { householdId: 'hh-1', role: 'owner' } as never,
        { buffer: await makeImage('png'), mimetype: 'image/png' } as never,
      );

      expect(parseAndCategorize).not.toHaveBeenCalled();
      expect(billCrudMock.createDraftFromParsed).not.toHaveBeenCalled();
      expect(res).toEqual({
        ...stored,
        request_id: 'req-old',
        duplicate: true,
      });
    });

    it('returns the stored draft when a concurrent upload saved it first', async () => {
      billCrudMock.findDraftByImageHash
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ parsed: stored, requestId: 'req-old' });
      parseAndCategorize.mockResolvedValue({
        parsed: { ...stored, draft_id: '', market_name: 'Lid1' },
        requestId: 'req-new',
        isReceipt: true,
      });
      billCrudMock.createDraftFromParsed.mockResolvedValue({
        id: 'draft-old',
        duplicate: true,
      });

      const res = await controller.parsePhoto(
        { id: 'user-xyz' } as never,
        { householdId: 'hh-1', role: 'owner' } as never,
        { buffer: await makeImage('png'), mimetype: 'image/png' } as never,
      );

      expect(res).toEqual({
        ...stored,
        request_id: 'req-old',
        duplicate: true,
      });
    });
  });

  it('falls back to the parsed bill when the saved draft is gone before it is read', async () => {
    const parsed = { draft_id: '', market_name: 'Lidl', items: [{}] };
    billCrudMock.findDraftByImageHash.mockResolvedValue(null);
    parseAndCategorize.mockResolvedValue({
      parsed,
      requestId: 'req-3',
      isReceipt: true,
    });
    billCrudMock.createDraftFromParsed.mockResolvedValue({
      id: 'draft-other',
      duplicate: true,
    });

    const res = await controller.parsePhoto(
      { id: 'user-xyz' } as never,
      { householdId: 'hh-1', role: 'owner' } as never,
      { buffer: await makeImage('png'), mimetype: 'image/png' } as never,
    );

    expect(res).toEqual({
      ...parsed,
      draft_id: 'draft-other',
      request_id: 'req-3',
      duplicate: true,
    });
  });

  it('answers 422 for a photo that is not a receipt and saves no draft', async () => {
    billCrudMock.findDraftByImageHash.mockResolvedValue(null);
    parseAndCategorize.mockResolvedValue({
      parsed: { items: [] },
      requestId: 'req-nr',
      isReceipt: false,
    });

    const err: unknown = await controller
      .parsePhoto(
        { id: 'user-xyz' } as never,
        { householdId: 'hh-1', role: 'owner' } as never,
        { buffer: await makeImage('png'), mimetype: 'image/png' } as never,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toEqual({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: expect.stringMatching(/not a receipt/) as string,
      request_id: 'req-nr',
    });
    expect(billCrudMock.createDraftFromParsed).not.toHaveBeenCalled();
  });

  it('ignores the client-sent "image/jpg" type of a real JPEG', async () => {
    parseAndCategorize.mockResolvedValue({
      parsed: { items: [{ name: 'BREAD' }] },
      requestId: 'req-2',
      isReceipt: true,
    });
    billCrudMock.findDraftByImageHash.mockResolvedValue(null);
    billCrudMock.createDraftFromParsed.mockResolvedValue({
      id: 'draft-2',
      duplicate: false,
    });

    await controller.parsePhoto(
      { id: 'user-xyz' } as never,
      { householdId: 'hh-1', role: 'owner' } as never,
      { buffer: await makeImage('jpeg'), mimetype: 'image/jpg' } as never,
    );

    expect(parseAndCategorize).toHaveBeenCalledWith(
      expect.any(Buffer),
      'image/jpeg',
      'hh-1',
      'user-xyz',
    );
  });

  it('answers 415 for a non-image and never calls the AI', async () => {
    const err: unknown = await controller
      .parsePhoto(
        { id: 'user-xyz' } as never,
        { householdId: 'hh-1', role: 'owner' } as never,
        { buffer: Buffer.from('plain text'), mimetype: 'image/jpeg' } as never,
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnsupportedMediaTypeException);
    expect(parseAndCategorize).not.toHaveBeenCalled();
  });

  describe('getDraftImage', () => {
    it('signs a 5-minute URL for the image of a draft of this household', async () => {
      billCrudMock.getDraftImageKey.mockResolvedValue('ai/images/abc.jpg');
      getSignedUrl.mockResolvedValue('https://s3.local/signed');

      const res = await controller.getDraftImage(
        { householdId: 'hh-1', role: 'member' } as never,
        'draft-1',
      );

      expect(billCrudMock.getDraftImageKey).toHaveBeenCalledWith(
        'draft-1',
        'hh-1',
      );
      expect(getSignedUrl).toHaveBeenCalledWith('ai/images/abc.jpg', 300);
      expect(res).toEqual({ url: 'https://s3.local/signed', expires_in: 300 });
    });
  });

  describe('parsePhoto limits', () => {
    const handler = Object.getOwnPropertyDescriptor(
      BillController.prototype,
      'parsePhoto',
    )!.value as object;

    it('throttles per user after the controller-level auth guards', () => {
      // Method guards run after class guards, so req.user is already set.
      expect(Reflect.getMetadata(GUARDS_METADATA, BillController)).toEqual([
        JwtAuthGuard,
        HouseholdMemberGuard,
      ]);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
        UserThrottlerGuard,
      ]);
    });

    it('maps AI usage-limit and gateway errors to HTTP', () => {
      const filters = Reflect.getMetadata(
        EXCEPTION_FILTERS_METADATA,
        handler,
      ) as unknown[];
      expect(filters).toContain(AiUsageLimitFilter);
      expect(filters).toContain(AiGatewayErrorFilter);
    });
  });

  describe('getDashboard', () => {
    it('delegates to BillDashboardService and returns its response', async () => {
      const response = { by_currency: [], bills: [] };
      billDashboardMock.getDashboard.mockResolvedValue(response);

      const query: BillDashboardQueryDto = {
        type: 'month',
        year: 2026,
        month: 4,
      };
      const result = await controller.getDashboard(
        { id: 'user-xyz' } as never,
        { householdId: 'hh-1', role: 'owner' } as never,
        query,
      );

      expect(billDashboardMock.getDashboard).toHaveBeenCalledWith(
        'hh-1',
        query,
      );
      expect(result).toBe(response);
    });
  });
});
