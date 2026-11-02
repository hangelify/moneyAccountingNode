/* eslint-disable @typescript-eslint/unbound-method */
import { Test } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';
import { CategoryDefaultsService } from './category-defaults.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HouseholdMemberGuard } from '../household/guards/household-member.guard';

describe('CategoryController', () => {
  let controller: CategoryController;
  const seedForHousehold = jest.fn();

  beforeEach(async () => {
    seedForHousehold.mockReset();
    const mod = await Test.createTestingModule({
      controllers: [CategoryController],
      providers: [
        { provide: CategoryService, useValue: {} },
        { provide: CategoryDefaultsService, useValue: { seedForHousehold } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(HouseholdMemberGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(CategoryController);
  });

  it('seedDefaults seeds the household resolved by HouseholdMemberGuard', async () => {
    seedForHousehold.mockResolvedValue({
      categoriesCreated: 3,
      subCategoriesCreated: 15,
    });

    await expect(
      controller.seedDefaults({ householdId: 'hh-42', role: 'member' }),
    ).resolves.toBeUndefined();

    expect(seedForHousehold).toHaveBeenCalledWith('hh-42');
  });

  it('seedDefaults responds with 204', () => {
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        CategoryController.prototype.seedDefaults,
      ),
    ).toBe(HttpStatus.NO_CONTENT);
  });

  it('is protected by JwtAuthGuard and HouseholdMemberGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CategoryController)).toEqual([
      JwtAuthGuard,
      HouseholdMemberGuard,
    ]);
  });
});
