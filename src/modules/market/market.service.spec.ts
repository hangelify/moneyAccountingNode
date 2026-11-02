/* eslint-disable @typescript-eslint/unbound-method */
import { NotFoundException } from '@nestjs/common';
import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { MarketService } from './market.service';
import { Market } from '../../entities/market.entity';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';

function makeService() {
  const marketRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
  } as unknown as EntityRepository<Market>;

  const em = {
    persist: jest.fn().mockReturnThis(),
    flush: jest.fn().mockResolvedValue(undefined),
    getConnection: jest.fn(),
    getReference: jest
      .fn()
      .mockImplementation((_cls: unknown, id: string) => ({ id })),
  } as unknown as EntityManager;

  const service = new MarketService(marketRepo, em);
  return { service, marketRepo, em };
}

const householdId = 'household-1';
const marketId = 'market-1';

describe('MarketService', () => {
  describe('createMarket', () => {
    it('creates and returns the new market', async () => {
      const { service, em } = makeService();
      (em.persist as jest.Mock).mockReturnThis();

      const dto: CreateMarketDto = {
        name: 'Lidl',
        city: 'Bucharest',
        country: 'RO',
      };
      const result = await service.createMarket(householdId, dto);

      expect(result.name).toBe('Lidl');
      expect(result.city).toBe('Bucharest');
      expect(result.country).toBe('RO');
      expect(em.flush as jest.Mock).toHaveBeenCalled();
    });
  });

  describe('listMarkets', () => {
    it('returns non-deleted markets for the household', async () => {
      const { service, marketRepo, em } = makeService();
      const markets = [
        {
          id: 'm1',
          name: 'Lidl',
          city: 'Bucharest',
          country: 'RO',
          created_at: new Date(),
        },
      ] as unknown as Market[];
      (marketRepo.find as jest.Mock).mockResolvedValue(markets);
      const mockConn = { execute: jest.fn().mockResolvedValue([]) };
      jest.spyOn(em, 'getConnection').mockReturnValue(mockConn as any);

      const result = await service.listMarkets(householdId);
      expect(result).toHaveLength(1);
      expect(marketRepo.find as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({
          household: { id: householdId },
          deleted_at: null,
        }),
      );
    });
  });

  describe('getMarket', () => {
    it('returns a market by id for the correct household', async () => {
      const { service, marketRepo } = makeService();
      const market = {
        id: marketId,
        name: 'Lidl',
        city: 'Bucharest',
        country: 'RO',
        created_at: new Date(),
      } as unknown as Market;
      (marketRepo.findOne as jest.Mock).mockResolvedValue(market);

      const result = await service.getMarket(marketId, householdId);
      expect(result.id).toBe(marketId);
    });

    it('throws NotFoundException when market not found', async () => {
      const { service, marketRepo } = makeService();
      (marketRepo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getMarket(marketId, householdId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateMarket', () => {
    it('updates fields and returns updated market', async () => {
      const { service, marketRepo, em } = makeService();
      const market = {
        id: marketId,
        name: 'Lidl',
        city: 'Bucharest',
        country: 'RO',
        created_at: new Date(),
      } as unknown as Market;
      (marketRepo.findOne as jest.Mock).mockResolvedValue(market);

      const dto: UpdateMarketDto = { name: 'Penny' };
      const result = await service.updateMarket(marketId, householdId, dto);

      expect(result.name).toBe('Penny');
      expect(em.flush as jest.Mock).toHaveBeenCalled();
    });

    it('throws NotFoundException when market not found', async () => {
      const { service, marketRepo } = makeService();
      (marketRepo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        service.updateMarket(marketId, householdId, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('softDeleteMarket', () => {
    it('sets deleted_at and flushes', async () => {
      const { service, marketRepo, em } = makeService();
      const market = {
        id: marketId,
        deleted_at: undefined,
      } as unknown as Market;
      (marketRepo.findOne as jest.Mock).mockResolvedValue(market);

      await service.softDeleteMarket(marketId, householdId);

      expect(market.deleted_at).toBeInstanceOf(Date);
      expect(em.flush as jest.Mock).toHaveBeenCalled();
    });

    it('throws NotFoundException when market not found', async () => {
      const { service, marketRepo } = makeService();
      (marketRepo.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        service.softDeleteMarket(marketId, householdId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('MarketService.listMarkets — bill count + ordering', () => {
  it('returns markets with bill_count and sorted by usage desc', async () => {
    const { service, marketRepo, em } = makeService();
    const now = new Date();
    const markets = [
      { id: 'm1', name: 'Lidl', created_at: now } as unknown as Market,
      { id: 'm2', name: 'Penny', created_at: now } as unknown as Market,
    ];
    (marketRepo.find as jest.Mock).mockResolvedValue(markets);
    const mockConn = {
      execute: jest.fn().mockResolvedValue([{ market_id: 'm1', cnt: '3' }]),
    };
    jest.spyOn(em, 'getConnection').mockReturnValue(mockConn as any);

    const result = await service.listMarkets('household-1');

    expect(result[0].id).toBe('m1');
    expect(result[0].bill_count).toBe(3);
    expect(result[1].id).toBe('m2');
    expect(result[1].bill_count).toBe(0);
  });
});
