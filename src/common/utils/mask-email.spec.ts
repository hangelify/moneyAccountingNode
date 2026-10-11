import { maskEmail } from './mask-email';

describe('maskEmail', () => {
  it('keeps the first character of the local part and the domain', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
  });

  it('lowercases and trims like stored emails', () => {
    expect(maskEmail('  Alice@Example.COM ')).toBe('a***@example.com');
  });

  it('masks a one-character local part fully', () => {
    expect(maskEmail('a@x.com')).toBe('a***@x.com');
  });

  it('uses the last @ as the separator', () => {
    expect(maskEmail('"a@b"@x.com')).toBe('"***@x.com');
  });

  it.each(['', 'no-at-sign', '@x.com'])(
    'reveals nothing of a malformed value %p',
    (value) => {
      expect(maskEmail(value)).toBe('***');
    },
  );
});
