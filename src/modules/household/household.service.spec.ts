import {
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EntityRepository, EntityManager } from '@mikro-orm/core';
import { HouseholdService } from './household.service';
import { Household } from '../../entities/household.entity';
import type { CategoryDefaultsService } from '../category/category-defaults.service';
import { HouseholdMember } from '../../entities/household-member.entity';
import { Currency } from '../../types/currency.enum';

process.env['FRONTEND_URL'] = 'https://app.example.com';

function makeService() {
  const memberRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
  } as unknown as EntityRepository<HouseholdMember>;
  const em = {
    persist: jest.fn().mockReturnThis(),
    flush: jest.fn().mockResolvedValue(undefined),
    getReference: jest.fn().mockReturnValue({}),
    find: jest.fn(),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    nativeDelete: jest.fn().mockResolvedValue(1),
    count: jest.fn().mockResolvedValue(0),
    getTransactionContext: jest.fn(),
    getConnection: jest
      .fn()
      .mockReturnValue({ execute: jest.fn().mockResolvedValue([]) }),
    transactional: jest
      .fn()
      .mockImplementation((fn: (em: EntityManager) => Promise<unknown>) =>
        fn(em),
      ),
  } as unknown as EntityManager;
  const categoryDefaults = {
    seedForHousehold: jest
      .fn()
      .mockResolvedValue({ categoriesCreated: 0, subCategoriesCreated: 0 }),
  } as unknown as CategoryDefaultsService;
  (em.findOneOrFail as jest.Mock).mockResolvedValue({
    currency: Currency.MDL,
  });
  return {
    service: new HouseholdService(
      memberRepo,
      em,
      { maxActiveInvites: 20, maxHouseholds: 5 },
      categoryDefaults,
    ),
    categoryDefaults,
    memberRepo,
    em,
  };
}

const userId = 'user-1';
const hid = 'hh-1';

describe('HouseholdService', () => {
  describe('createHousehold', () => {
    it('creates household + owner membership and returns DTO', async () => {
      const { service, em, categoryDefaults } = makeService();
      const result = await service.createHousehold(userId, { name: 'Family' });
      expect(em.flush as jest.Mock).toHaveBeenCalled();
      // Seeded in the creating transaction, so a failed seed rolls it back.
      expect(categoryDefaults.seedForHousehold).toHaveBeenCalledWith(
        undefined,
        em,
      );
      expect(result.name).toBe('Family');
      expect(result.member_count).toBe(1);
    });

    it("without currency uses the creator's currency", async () => {
      const { service } = makeService();
      const result = await service.createHousehold(userId, { name: 'Family' });
      expect(result.currency).toBe(Currency.MDL);
    });

    it('with currency USD keeps USD', async () => {
      const { service } = makeService();
      const result = await service.createHousehold(userId, {
        name: 'Family',
        currency: Currency.USD,
      });
      expect(result.currency).toBe(Currency.USD);
    });
  });

  describe('assertOwner', () => {
    it('does nothing when role is owner', () => {
      const { service } = makeService();
      expect(() => {
        service.assertOwner({ householdId: hid, role: 'owner' });
      }).not.toThrow();
    });

    it('throws ForbiddenException when role is member', () => {
      const { service } = makeService();
      expect(() => {
        service.assertOwner({ householdId: hid, role: 'member' });
      }).toThrow(ForbiddenException);
    });
  });

  describe('updateHousehold', () => {
    it('updates the name and returns DTO', async () => {
      const { service, memberRepo, em } = makeService();
      const household = {
        id: hid,
        name: 'Old',
        created_at: new Date(),
        deleted_at: null,
      };
      (em.findOne as jest.Mock).mockResolvedValue(household);
      (memberRepo.find as jest.Mock).mockResolvedValue([]);

      const result = await service.updateHousehold(hid, { name: 'New' });

      expect(household.name).toBe('New');
      expect(em.flush as jest.Mock).toHaveBeenCalled();
      expect(result.name).toBe('New');
    });

    it('changes only currency when name is absent', async () => {
      const { service, memberRepo, em } = makeService();
      const household = {
        id: hid,
        name: 'Old',
        currency: Currency.EUR,
        created_at: new Date(),
        deleted_at: null,
      };
      (em.findOne as jest.Mock).mockResolvedValue(household);
      (memberRepo.find as jest.Mock).mockResolvedValue([]);

      const result = await service.updateHousehold(hid, {
        currency: Currency.USD,
      });

      expect(household.name).toBe('Old');
      expect(result.name).toBe('Old');
      expect(result.currency).toBe(Currency.USD);
    });

    it('rejects an empty update', async () => {
      const { service } = makeService();
      await expect(service.updateHousehold(hid, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws NotFoundException when household not found', async () => {
      const { service, em } = makeService();
      (em.findOne as jest.Mock).mockResolvedValue(null);
      await expect(
        service.updateHousehold(hid, { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('softDeleteHousehold', () => {
    it('sets deleted_at on the household', async () => {
      const { service, em } = makeService();
      const household = {
        id: hid,
        deleted_at: undefined,
      } as unknown as Household;
      (em.findOne as jest.Mock).mockResolvedValue(household);
      // One member (the owner), two live households of the owner.
      (em.count as jest.Mock).mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      await service.softDeleteHousehold(hid, userId);

      expect(household.deleted_at).toBeInstanceOf(Date);
    });

    it('throws NotFoundException when household not found', async () => {
      const { service, em } = makeService();
      (em.findOne as jest.Mock).mockResolvedValue(null);
      await expect(
        service.softDeleteHousehold(hid, userId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('removeMember', () => {
    it('throws ConflictException when sole owner tries to remove themselves', async () => {
      const { service, memberRepo, em } = makeService();
      (memberRepo.findOne as jest.Mock).mockResolvedValue({ role: 'owner' });
      (em.find as jest.Mock).mockResolvedValue([
        { role: 'owner', user: { id: userId } },
      ]);

      await expect(
        service.removeMember(hid, userId, userId),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});

describe('HouseholdService email verification gate', () => {
  it('refuses to create an invite for an unverified inviter', async () => {
    const { service, em } = makeService();

    await expect(
      service.createInvite(
        hid,
        { id: userId, email_verified_at: null },
        { email: 'jane@example.com' },
      ),
    ).rejects.toThrow(new ForbiddenException('Email address is not verified'));
    expect(em.transactional as jest.Mock).not.toHaveBeenCalled();
  });

  it('refuses to accept an invite for an unverified user', async () => {
    const { service, em } = makeService();

    await expect(
      service.acceptInvite('a'.repeat(64), {
        id: userId,
        email: 'jane@example.com',
        email_verified_at: null,
      }),
    ).rejects.toThrow(new ForbiddenException('Email address is not verified'));
    expect(em.transactional as jest.Mock).not.toHaveBeenCalled();
  });
});
