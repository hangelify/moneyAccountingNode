import type { EntityManager } from '@mikro-orm/core';
import { Bill } from '../../entities/bill.entity';
import { BillDuplicatesService } from './bill-duplicates.service';

describe('BillDuplicatesService.linkAsDuplicate', () => {
  it('throws on a bill without an id and issues no query or update', async () => {
    const findOne = jest.fn();
    const nativeUpdate = jest.fn();
    const em = { findOne, nativeUpdate } as unknown as EntityManager;
    const service = new BillDuplicatesService(em);

    await expect(
      service.linkAsDuplicate(em, new Bill(), 'other-id', 'household-1'),
    ).rejects.toThrow('flushed');

    expect(findOne).not.toHaveBeenCalled();
    expect(nativeUpdate).not.toHaveBeenCalled();
  });
});
