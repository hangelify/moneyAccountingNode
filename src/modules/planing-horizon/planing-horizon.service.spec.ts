/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { PlaningHorizonService } from './planing-horizon.service';
import { PlaningHorizon } from '../../entities/planing-horizon.entity';
import { Budget } from '../../entities/budget.entity';

function makeService() {
  const phRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
  } as unknown as EntityRepository<PlaningHorizon>;
  const budgetRepo = {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
  } as unknown as EntityRepository<Budget>;
  const em = {
    persist: jest.fn().mockReturnThis(),
    flush: jest.fn().mockResolvedValue(undefined),
  } as unknown as EntityManager;
  return {
    service: new PlaningHorizonService(phRepo, budgetRepo, em),
    phRepo,
  };
}

describe('PlaningHorizonService.listPlaningHorizons', () => {
  it('returns non-archived, non-deleted horizons for the household', async () => {
    const { service, phRepo } = makeService();
    const horizons = [
      {
        id: 'ph1',
        name: 'Q1',
        amount: 1000,
        currency: 'EUR',
        period_type: 'monthly',
        created_at: new Date(),
        updated_at: new Date(),
        is_archived: false,
        budget: { id: 'b1' },
      },
    ] as unknown as PlaningHorizon[];
    (phRepo.find as jest.Mock).mockResolvedValue(horizons);

    const result = await service.listPlaningHorizons('household-1');

    expect(result).toHaveLength(1);
    expect(phRepo.find as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        is_archived: false,
        deleted_at: null,
        budget: expect.objectContaining({
          household: { id: 'household-1' },
          deleted_at: null,
        }),
      }),
      expect.objectContaining({ populate: ['budget'] }),
    );
  });
});
