import { readDraftRetentionDays } from './draft-cleanup.env';

describe('readDraftRetentionDays', () => {
  const original = process.env.DRAFT_RETENTION_DAYS;
  afterEach(() => {
    if (original === undefined) delete process.env.DRAFT_RETENTION_DAYS;
    else process.env.DRAFT_RETENTION_DAYS = original;
  });

  it('defaults to 30 days', () => {
    delete process.env.DRAFT_RETENTION_DAYS;
    expect(readDraftRetentionDays()).toBe(30);
  });

  it('reads a positive whole number of days', () => {
    process.env.DRAFT_RETENTION_DAYS = '7';
    expect(readDraftRetentionDays()).toBe(7);
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'refuses to start with DRAFT_RETENTION_DAYS=%s',
    (value) => {
      process.env.DRAFT_RETENTION_DAYS = value;
      expect(() => readDraftRetentionDays()).toThrow(/DRAFT_RETENTION_DAYS/);
    },
  );
});
