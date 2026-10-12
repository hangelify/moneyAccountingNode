import { isAmountMismatch, readBillItemTolerance } from './bill-totals';

describe('readBillItemTolerance', () => {
  const original = process.env.BILL_ITEM_TOLERANCE;
  afterEach(() => {
    if (original === undefined) delete process.env.BILL_ITEM_TOLERANCE;
    else process.env.BILL_ITEM_TOLERANCE = original;
  });

  it('defaults to one cent per item', () => {
    delete process.env.BILL_ITEM_TOLERANCE;
    expect(readBillItemTolerance()).toBe(0.01);
  });

  it('reads a non-negative amount with at most two decimals', () => {
    process.env.BILL_ITEM_TOLERANCE = '0.05';
    expect(readBillItemTolerance()).toBe(0.05);
    process.env.BILL_ITEM_TOLERANCE = '0.07';
    expect(readBillItemTolerance()).toBe(0.07);
    process.env.BILL_ITEM_TOLERANCE = '0';
    expect(readBillItemTolerance()).toBe(0);
  });

  it.each(['-0.01', '0.001', 'abc', 'Infinity'])(
    'refuses to start with BILL_ITEM_TOLERANCE=%s',
    (value) => {
      process.env.BILL_ITEM_TOLERANCE = value;
      expect(() => readBillItemTolerance()).toThrow(/BILL_ITEM_TOLERANCE/);
    },
  );
});

describe('isAmountMismatch', () => {
  it('matches when the items add up to the total exactly', () => {
    expect(isAmountMismatch(0.3, [0.1, 0.2], 0)).toBe(false);
  });

  it('allows a difference of up to the tolerance per item', () => {
    // 2 items x 0.01 => up to 0.02 apart.
    expect(isAmountMismatch(10.02, [5, 5], 0.01)).toBe(false);
    expect(isAmountMismatch(9.98, [5, 5], 0.01)).toBe(false);
  });

  it('flags a difference beyond the tolerance', () => {
    expect(isAmountMismatch(10.03, [5, 5], 0.01)).toBe(true);
    expect(isAmountMismatch(9.97, [5, 5], 0.01)).toBe(true);
  });

  it('flags items summing above a discounted total', () => {
    expect(isAmountMismatch(18, [10, 10], 0.01)).toBe(true);
  });

  it('reads decimal columns returned as strings', () => {
    expect(isAmountMismatch('10.00', ['4.50', '5.50'], 0)).toBe(false);
  });

  it('flags a bill without items whose total is not zero', () => {
    expect(isAmountMismatch(5, [], 0.01)).toBe(true);
  });
});
