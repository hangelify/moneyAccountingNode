import { sanitizeIp } from './ip.util';

describe('sanitizeIp', () => {
  it.each([
    '127.0.0.1',
    '203.0.113.7',
    '::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('keeps valid IP %p', (ip) => {
    expect(sanitizeIp(ip)).toBe(ip);
  });

  it.each([
    undefined,
    null,
    '',
    'unknown',
    'a'.repeat(100),
    '1.2.3.4, 5.6.7.8',
  ])('returns null for invalid value %p', (ip) => {
    expect(sanitizeIp(ip)).toBeNull();
  });

  it('returns null for a syntactically valid IPv6 that does not fit varchar(45)', () => {
    const ip = `fe80::1%${'x'.repeat(60)}`;
    expect(sanitizeIp(ip)).toBeNull();
  });
});
