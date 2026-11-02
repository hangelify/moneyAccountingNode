import { addMoney } from './money.util';

describe('addMoney', () => {
  it('adds 0.1 and 0.2 to exactly 0.3', () => {
    expect(addMoney(0.1, 0.2)).toBe(0.3);
  });

  it('keeps cents exact across many additions', () => {
    let total = 0;
    for (let i = 0; i < 1000; i++) total = addMoney(total, 0.01);
    expect(total).toBe(10);
  });

  it('adds large amounts without losing cents', () => {
    expect(addMoney(999_999_999_999.99, 0.01)).toBe(1_000_000_000_000);
  });
});
