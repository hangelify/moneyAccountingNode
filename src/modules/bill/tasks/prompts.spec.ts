import {
  BILL_PARSER_SYSTEM_PROMPT,
  BILL_PARSE_CATEGORIZE_SYSTEM_PROMPT,
} from './prompts';
import { ParsedBillItemSchema } from './schemas/parsed-bill.schema';

// Item amounts are net of discounts so items add up to the bill total and
// category statistics match the per-period totals.
describe.each([
  ['parser', BILL_PARSER_SYSTEM_PROMPT],
  ['parse-and-categorize', BILL_PARSE_CATEGORIZE_SYSTEM_PROMPT],
])('%s prompt', (_, prompt) => {
  it('asks for final_price net of discounts', () => {
    expect(prompt).toMatch(/final_price.*after (its )?discount/i);
  });

  it('asks to spread a whole-receipt discount over the items', () => {
    expect(prompt).toMatch(/discount on the whole receipt/i);
  });

  it('no longer just drops discount lines', () => {
    expect(prompt).not.toMatch(/Do not include discount lines/);
  });
});

describe('ParsedBillItemSchema', () => {
  it('describes final_price as the amount after discount', () => {
    expect(ParsedBillItemSchema.shape.final_price.description).toMatch(
      /after (its )?discount/i,
    );
  });
});
