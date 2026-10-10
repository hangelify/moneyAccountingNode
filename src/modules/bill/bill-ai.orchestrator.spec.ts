import { BillAiOrchestrator } from './bill-ai.orchestrator';
import type { AiGatewayService } from '../ai-gateway/ai-gateway.service';
import type { BillParserTask } from './tasks/bill-parser.task';
import type { BillParseCategorizeTask } from './tasks/bill-parse-categorize.task';

describe('BillAiOrchestrator', () => {
  it('parseAndCategorize makes a single combined AI call with image and subcategories', async () => {
    const bill = {
      market_name: 'Test',
      bill_date: '2026-05-08',
      currency: 'EUR',
      total_amount: 10,
      items: [
        {
          name: 'BREAD',
          quantity: 1,
          unit: 'piece',
          weight_kg: null,
          price_per_kg: null,
          final_price: 2,
          sub_category_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          category_confidence: 0.9,
        },
      ],
    };
    const subcategories = [
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        category_name: 'Bakery',
        sub_category_name: 'Bread',
      },
    ];

    const runMock = jest
      .fn()
      .mockResolvedValueOnce({ data: bill, requestId: 'req-1' });
    const parser = { name: 'bill.parse' } as unknown as BillParserTask;
    const parseCategorize = {
      name: 'bill.parse-categorize',
    } as unknown as BillParseCategorizeTask;
    const gateway = { run: runMock } as unknown as AiGatewayService;

    const orchestrator = new BillAiOrchestrator(
      gateway,
      parser,
      parseCategorize,
    );
    const buf = Buffer.from('img');
    const result = await orchestrator.parseAndCategorize(
      buf,
      'image/png',
      'user-123',
      subcategories,
    );

    expect(result).toEqual({ data: bill, requestId: 'req-1' });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      parseCategorize,
      { image: buf, mediaType: 'image/png', subcategories },
      { userId: 'user-123' },
    );
  });

  it('parseOnly calls only the parser and returns its ParsedBill with the request id', async () => {
    const parsed = {
      market_name: 'Lidl',
      bill_date: null,
      currency: null,
      total_amount: null,
      items: [],
    };
    const out = { data: parsed, requestId: 'req-2' };
    const runMock = jest.fn().mockResolvedValueOnce(out);
    const parser = { name: 'bill.parse' } as unknown as BillParserTask;
    const parseCategorize = {
      name: 'bill.parse-categorize',
    } as unknown as BillParseCategorizeTask;
    const gateway = { run: runMock } as unknown as AiGatewayService;

    const orchestrator = new BillAiOrchestrator(
      gateway,
      parser,
      parseCategorize,
    );
    const buf = Buffer.from('img');
    const res = await orchestrator.parseOnly(buf, 'image/jpeg', 'user-1');

    expect(res).toBe(out);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      parser,
      { image: buf, mediaType: 'image/jpeg' },
      { userId: 'user-1' },
    );
  });
});
