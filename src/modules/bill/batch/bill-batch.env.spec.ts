import { readBillBatchEnv } from './bill-batch.env';

describe('readBillBatchEnv', () => {
  it('defaults to enabled, concurrency 2, attempts 3, 2 concurrent uploads', () => {
    expect(readBillBatchEnv({})).toEqual({
      enabled: true,
      concurrency: 2,
      attempts: 3,
      maxConcurrentUploads: 2,
    });
  });

  it('reads the variables', () => {
    expect(
      readBillBatchEnv({
        BILL_BATCH_ENABLED: 'false',
        BILL_BATCH_CONCURRENCY: '4',
        BILL_BATCH_ATTEMPTS: '1',
        BILL_BATCH_MAX_CONCURRENT_UPLOADS: '5',
      }),
    ).toEqual({
      enabled: false,
      concurrency: 4,
      attempts: 1,
      maxConcurrentUploads: 5,
    });
  });

  it.each([
    [{ BILL_BATCH_ENABLED: 'yes' }],
    [{ BILL_BATCH_CONCURRENCY: '0' }],
    [{ BILL_BATCH_ATTEMPTS: 'x' }],
    [{ BILL_BATCH_MAX_CONCURRENT_UPLOADS: '0' }],
  ])('rejects %j', (env) => {
    expect(() => readBillBatchEnv(env)).toThrow(/BILL_BATCH_/);
  });
});
