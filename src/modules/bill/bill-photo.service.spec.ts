import { BillPhotoService } from './bill-photo.service';
import type { BillAiOrchestrator } from './bill-ai.orchestrator';
import type { EntityRepository } from '@mikro-orm/core';
import type { SubCategory } from '../../entities/sub-category.entity';

describe('BillPhotoService', () => {
  const USER_ID = 'user-1';
  const HOUSEHOLD_ID = 'household-1';

  function makeSubs() {
    return [
      { id: 'sub-a', name: 'bun', category: { name: 'Bread' } },
      { id: 'sub-b', name: 'milk', category: { name: 'Dairy' } },
    ];
  }

  function makeOrchestrator(opts: {
    bill?: unknown;
    parseOnlyResult?: unknown;
  }): BillAiOrchestrator {
    return {
      parseAndCategorize: jest
        .fn()
        .mockResolvedValue({ data: opts.bill, requestId: 'req-cat' }),
      parseOnly: jest
        .fn()
        .mockResolvedValue({ data: opts.parseOnlyResult, requestId: 'req-p' }),
    } as never;
  }

  function makeRepo(found: unknown[]): EntityRepository<SubCategory> {
    return {
      find: jest.fn().mockResolvedValue(found),
    } as never;
  }

  it('merges parsed + categorized into a single item list with sub_category names', async () => {
    const bill = {
      market_name: 'Lidl',
      bill_date: '2026-05-07',
      currency: 'EUR',
      total_amount: 3.5,
      items: [
        {
          name: 'BREAD',
          quantity: 1,
          unit: 'piece',
          weight_kg: null,
          price_per_kg: null,
          final_price: 1.2,
          sub_category_id: 'sub-a',
          category_confidence: 0.95,
          category_reasoning: 'bread',
        },
        {
          name: 'MILK',
          quantity: 1,
          unit: 'piece',
          weight_kg: null,
          price_per_kg: null,
          final_price: 2.3,
          sub_category_id: 'sub-b',
          category_confidence: 0.9,
        },
      ],
      raw_extracted_text: '...',
    };
    const svc = new BillPhotoService(
      makeOrchestrator({ bill }),
      makeRepo(makeSubs()),
    );
    const { parsed: res } = await svc.parseAndCategorize(
      Buffer.from('x'),
      'image/png',
      HOUSEHOLD_ID,
      USER_ID,
    );
    expect(res.items).toHaveLength(2);
    expect(res.items[0].sub_category).toEqual({
      id: 'sub-a',
      name: 'bun',
      category_name: 'Bread',
    });
    expect(res.items[0].category_confidence).toBe(0.95);
    expect(res.items[0].category_reasoning).toBe('bread');
    expect(res.items[1].sub_category).toEqual({
      id: 'sub-b',
      name: 'milk',
      category_name: 'Dairy',
    });
  });

  it('sets sub_category null when AI returned null sub_category_id', async () => {
    const bill = {
      market_name: null,
      bill_date: null,
      currency: null,
      total_amount: null,
      items: [
        {
          name: 'UNKNOWN',
          quantity: 1,
          unit: 'piece',
          weight_kg: null,
          price_per_kg: null,
          final_price: 1,
          sub_category_id: null,
          category_confidence: 0.1,
        },
      ],
      raw_extracted_text: '',
    };
    const svc = new BillPhotoService(
      makeOrchestrator({ bill }),
      makeRepo(makeSubs()),
    );
    const { parsed: res } = await svc.parseAndCategorize(
      Buffer.from('x'),
      'image/png',
      HOUSEHOLD_ID,
      USER_ID,
    );
    expect(res.items[0].sub_category).toBeNull();
    expect(res.items[0].category_confidence).toBe(0.1);
  });

  it('defensively sets sub_category null when AI returned an unrecognised id (hallucination)', async () => {
    const bill = {
      market_name: null,
      bill_date: null,
      currency: null,
      total_amount: null,
      items: [
        {
          name: 'X',
          quantity: 1,
          unit: 'piece',
          weight_kg: null,
          price_per_kg: null,
          final_price: 1,
          sub_category_id: 'ghost-id',
          category_confidence: 0.8,
        },
      ],
      raw_extracted_text: '',
    };
    const svc = new BillPhotoService(
      makeOrchestrator({ bill }),
      makeRepo(makeSubs()),
    );
    const { parsed: res } = await svc.parseAndCategorize(
      Buffer.from('x'),
      'image/png',
      HOUSEHOLD_ID,
      USER_ID,
    );
    expect(res.items[0].sub_category).toBeNull();
  });

  it('reports a confidence the schema dropped as 0', async () => {
    const bill = {
      market_name: null,
      bill_date: null,
      currency: null,
      total_amount: null,
      items: [
        {
          name: 'X',
          quantity: 1,
          unit: 'piece',
          weight_kg: null,
          price_per_kg: null,
          final_price: 1,
          sub_category_id: 'sub-a',
          category_confidence: null,
          category_reasoning: null,
        },
      ],
      raw_extracted_text: '',
    };
    const svc = new BillPhotoService(
      makeOrchestrator({ bill }),
      makeRepo(makeSubs()),
    );
    const { parsed: res } = await svc.parseAndCategorize(
      Buffer.from('x'),
      'image/png',
      HOUSEHOLD_ID,
      USER_ID,
    );
    expect(res.items[0].category_confidence).toBe(0);
    expect(res.items[0].category_reasoning).toBeUndefined();
  });

  it.each([
    ['categorizing', makeSubs(), 'req-cat'],
    ['parse-only', [], 'req-p'],
  ])(
    'returns the AI request id (%s)',
    async (_mode, subs, expectedRequestId) => {
      const empty = {
        market_name: null,
        bill_date: null,
        currency: null,
        total_amount: null,
        items: [],
        raw_extracted_text: '',
      };
      const svc = new BillPhotoService(
        makeOrchestrator({ bill: empty, parseOnlyResult: empty }),
        makeRepo(subs),
      );
      const { requestId } = await svc.parseAndCategorize(
        Buffer.from('x'),
        'image/png',
        HOUSEHOLD_ID,
        USER_ID,
      );
      expect(requestId).toBe(expectedRequestId);
    },
  );

  it('short-circuits: when user has zero subcategories, skips categorizer call and returns null sub_category for every item', async () => {
    const parseOnlyResult = {
      market_name: null,
      bill_date: null,
      currency: null,
      total_amount: null,
      items: [
        {
          name: 'A',
          quantity: 1,
          unit: 'piece',
          weight_kg: null,
          price_per_kg: null,
          final_price: 1,
        },
        {
          name: 'B',
          quantity: 1,
          unit: 'piece',
          weight_kg: null,
          price_per_kg: null,
          final_price: 2,
        },
      ],
      raw_extracted_text: '',
    };
    const orchestrator = makeOrchestrator({ parseOnlyResult });
    const repo = makeRepo([]);

    const svc = new BillPhotoService(orchestrator, repo);
    const { parsed: res } = await svc.parseAndCategorize(
      Buffer.from('x'),
      'image/png',
      HOUSEHOLD_ID,
      USER_ID,
    );

    expect(
      (orchestrator as unknown as { parseOnly: jest.Mock }).parseOnly,
    ).toHaveBeenCalledTimes(1);
    expect(
      (orchestrator as unknown as { parseAndCategorize: jest.Mock })
        .parseAndCategorize,
    ).not.toHaveBeenCalled();
    expect(
      res.items.every(
        (i) => i.sub_category === null && i.category_confidence === 0,
      ),
    ).toBe(true);
  });

  it('passes subcategory info derived from fetched subs to the orchestrator', async () => {
    const subs = makeSubs();
    const orchestrator = makeOrchestrator({
      bill: {
        market_name: null,
        bill_date: null,
        currency: null,
        total_amount: null,
        items: [],
        raw_extracted_text: '',
      },
    });
    const svc = new BillPhotoService(orchestrator, makeRepo(subs));

    await svc.parseAndCategorize(
      Buffer.from('x'),
      'image/png',
      HOUSEHOLD_ID,
      USER_ID,
    );

    expect(
      (orchestrator as unknown as { parseAndCategorize: jest.Mock })
        .parseAndCategorize,
    ).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', USER_ID, [
      { id: 'sub-a', category_name: 'Bread', sub_category_name: 'bun' },
      { id: 'sub-b', category_name: 'Dairy', sub_category_name: 'milk' },
    ]);
  });
});
