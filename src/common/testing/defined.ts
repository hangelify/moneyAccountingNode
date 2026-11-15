/**
 * Test helper: narrows `T | undefined` to `T`, failing the test with a clear
 * message instead of a TypeError further down. Use it on `rows[0]` and the
 * like under noUncheckedIndexedAccess; production code checks explicitly.
 */
export function defined<T>(value: T | undefined, what = 'value'): T {
  if (value === undefined) {
    throw new Error(`Expected ${what} to be defined`);
  }
  return value;
}
