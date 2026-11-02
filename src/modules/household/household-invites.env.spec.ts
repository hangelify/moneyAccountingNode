import { readMaxActiveInvites } from './household-invites.env';

describe('readMaxActiveInvites', () => {
  const original = process.env.HOUSEHOLD_MAX_ACTIVE_INVITES;
  afterEach(() => {
    if (original === undefined) delete process.env.HOUSEHOLD_MAX_ACTIVE_INVITES;
    else process.env.HOUSEHOLD_MAX_ACTIVE_INVITES = original;
  });

  it('defaults to 20 invites', () => {
    delete process.env.HOUSEHOLD_MAX_ACTIVE_INVITES;
    expect(readMaxActiveInvites()).toBe(20);
  });

  it('reads a positive whole number', () => {
    process.env.HOUSEHOLD_MAX_ACTIVE_INVITES = '5';
    expect(readMaxActiveInvites()).toBe(5);
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'refuses to start with HOUSEHOLD_MAX_ACTIVE_INVITES=%s',
    (value) => {
      process.env.HOUSEHOLD_MAX_ACTIVE_INVITES = value;
      expect(() => readMaxActiveInvites()).toThrow(
        /HOUSEHOLD_MAX_ACTIVE_INVITES/,
      );
    },
  );
});
