import { readBillBatchEnv } from './bill-batch.env';

describe('readBillBatchEnv', () => {
  it('defaults to enabled, concurrency 2, attempts 3', () => {
    expect(readBillBatchEnv({})).toEqual({
      enabled: true,
      concurrency: 2,
      attempts: 3,
    });
  });

  it('reads the variables', () => {
    expect(
      readBillBatchEnv({
        BILL_BATCH_ENABLED: 'false',
        BILL_BATCH_CONCURRENCY: '4',
        BILL_BATCH_ATTEMPTS: '1',
      }),
    ).toEqual({ enabled: false, concurrency: 4, attempts: 1 });
  });

  it.each([
    [{ BILL_BATCH_ENABLED: 'yes' }],
    [{ BILL_BATCH_CONCURRENCY: '0' }],
    [{ BILL_BATCH_ATTEMPTS: 'x' }],
  ])('rejects %j', (env) => {
    expect(() => readBillBatchEnv(env)).toThrow(/BILL_BATCH_/);
  });
});
