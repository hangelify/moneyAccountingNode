import { defined } from './defined';

describe('defined', () => {
  it('returns the value when it is present', () => {
    expect(defined([5][0])).toBe(5);
  });

  it('keeps null and falsy values', () => {
    expect(defined<number | null>(null)).toBeNull();
    expect(defined(0)).toBe(0);
  });

  it('throws a named error for undefined', () => {
    expect(() => defined<string>(undefined, 'first row')).toThrow(
      'Expected first row to be defined',
    );
  });
});
