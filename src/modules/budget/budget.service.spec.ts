/* eslint-disable @typescript-eslint/unbound-method */
import { EntityManager, EntityRepository } from '@mikro-orm/core';
import { BudgetService } from './budget.service';
import { Budget } from '../../entities/budget.entity';

function makeService() {
  const budgetRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
  } as unknown as EntityRepository<Budget>;
  const em = {
    persist: jest.fn().mockReturnThis(),
    flush: jest.fn().mockResolvedValue(undefined),
    getReference: jest.fn(),
  } as unknown as EntityManager;
  return { service: new BudgetService(budgetRepo, em), budgetRepo };
}

describe('BudgetService.listBudgets', () => {
  it('returns non-deleted budgets for the household', async () => {
    const { service, budgetRepo } = makeService();
    const budgets = [
      {
        id: 'b1',
        name: 'Monthly',
        description: undefined,
        created_at: new Date(),
      },
    ] as unknown as Budget[];
    (budgetRepo.find as jest.Mock).mockResolvedValue(budgets);

    const result = await service.listBudgets('household-1');

    expect(result).toHaveLength(1);
    expect(budgetRepo.find as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        household: { id: 'household-1' },
        deleted_at: null,
      }),
    );
  });
});
