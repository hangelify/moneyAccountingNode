import { Test } from '@nestjs/testing';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import { APP_FILTER } from '@nestjs/core';
import { BillController } from './bill.controller';
import { BillPhotoService } from './bill-photo.service';
import { BillCrudService } from './bill-crud.service';
import { BillDashboardService } from './bill-dashboard.service';
import { BillDashboardQueryDto } from './dto/bill-dashboard.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HouseholdMemberGuard } from '../household/guards/household-member.guard';
import { AiGatewayExhaustedFilter } from './filters/ai-gateway-exhausted.filter';
import { AiUsageLimitFilter } from './filters/ai-usage-limit.filter';
import { UserThrottlerGuard } from '../ai-gateway/guards/user-throttler.guard';

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
    listDrafts: jest.fn(),
    confirmBill: jest.fn(),
  };

  beforeEach(async () => {
    parseAndCategorize.mockReset();
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
        { provide: APP_FILTER, useClass: AiGatewayExhaustedFilter },
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

  it('forwards multer file buffer + mime + user id to BillPhotoService and returns its response', async () => {
    const dto = {
      market_name: null,
      bill_date: null,
      currency: null,
      total_amount: null,
      items: [],
      raw_extracted_text: '',
    };
    const draftId = 'draft-uuid-001';
    parseAndCategorize.mockResolvedValue(dto);
    billCrudMock.createDraftFromParsed.mockResolvedValue(draftId);
    const fakeFile = {
      buffer: Buffer.from([1, 2, 3]),
      mimetype: 'image/png',
    } as Express.Multer.File;
    const res = await controller.parsePhoto(
      { id: 'user-xyz' } as never,
      { householdId: 'hh-1', role: 'owner' } as never,
      fakeFile,
    );
    expect(parseAndCategorize).toHaveBeenCalledWith(
      fakeFile.buffer,
      'image/png',
      'hh-1',
      'user-xyz',
    );
    expect(billCrudMock.createDraftFromParsed).toHaveBeenCalledWith(
      'hh-1',
      'user-xyz',
      dto,
    );
    expect(res).toEqual({ ...dto, draft_id: draftId });
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

    it('maps AI usage-limit errors to HTTP', () => {
      expect(
        Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, handler),
      ).toContain(AiUsageLimitFilter);
    });
  });

  describe('getDashboard', () => {
    it('delegates to BillDashboardService and returns its response', async () => {
      const response = { period_totals: [], bills: [], category_stats: [] };
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
