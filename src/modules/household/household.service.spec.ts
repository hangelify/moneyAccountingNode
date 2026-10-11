/* eslint-disable @typescript-eslint/unbound-method */
import {
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EntityRepository, EntityManager } from '@mikro-orm/core';
import { HouseholdService } from './household.service';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';

process.env.FRONTEND_URL = 'https://app.example.com';

function makeService() {
  const householdRepo = {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    find: jest.fn(),
  } as unknown as EntityRepository<Household>;
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
    nativeDelete: jest.fn().mockResolvedValue(1),
    transactional: jest
      .fn()
      .mockImplementation((fn: (em: EntityManager) => Promise<unknown>) =>
        fn(em),
      ),
  } as unknown as EntityManager;
  return {
    service: new HouseholdService(householdRepo, memberRepo, em, 20),
    householdRepo,
    memberRepo,
    em,
  };
}

const userId = 'user-1';
const hid = 'hh-1';

describe('HouseholdService', () => {
  describe('createHousehold', () => {
    it('creates household + owner membership and returns DTO', async () => {
      const { service, em } = makeService();
      const result = await service.createHousehold(userId, { name: 'Family' });
      expect(em.flush as jest.Mock).toHaveBeenCalled();
      expect(result.name).toBe('Family');
      expect(result.member_count).toBe(1);
    });
  });

  describe('assertOwner', () => {
    it('does nothing when role is owner', () => {
      const { service } = makeService();
      expect(() =>
        service.assertOwner({ householdId: hid, role: 'owner' }),
      ).not.toThrow();
    });

    it('throws ForbiddenException when role is member', () => {
      const { service } = makeService();
      expect(() =>
        service.assertOwner({ householdId: hid, role: 'member' }),
      ).toThrow(ForbiddenException);
    });
  });

  describe('renameHousehold', () => {
    it('updates the name and returns DTO', async () => {
      const { service, householdRepo, memberRepo, em } = makeService();
      const household = {
        id: hid,
        name: 'Old',
        created_at: new Date(),
        deleted_at: null,
      };
      (householdRepo.findOne as jest.Mock).mockResolvedValue(household);
      (memberRepo.find as jest.Mock).mockResolvedValue([]);

      const result = await service.renameHousehold(hid, { name: 'New' });

      expect(household.name).toBe('New');
      expect(em.flush as jest.Mock).toHaveBeenCalled();
      expect(result.name).toBe('New');
    });

    it('throws NotFoundException when household not found', async () => {
      const { service, householdRepo } = makeService();
      (householdRepo.findOne as jest.Mock).mockResolvedValue(null);
      await expect(
        service.renameHousehold(hid, { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('softDeleteHousehold', () => {
    it('sets deleted_at on the household', async () => {
      const { service, householdRepo, em } = makeService();
      const household = {
        id: hid,
        deleted_at: undefined,
      } as unknown as Household;
      (householdRepo.findOne as jest.Mock).mockResolvedValue(household);

      await service.softDeleteHousehold(hid);

      expect(household.deleted_at).toBeInstanceOf(Date);
      expect(em.flush as jest.Mock).toHaveBeenCalled();
    });

    it('throws NotFoundException when household not found', async () => {
      const { service, householdRepo } = makeService();
      (householdRepo.findOne as jest.Mock).mockResolvedValue(null);
      await expect(service.softDeleteHousehold(hid)).rejects.toBeInstanceOf(
        NotFoundException,
      );
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
