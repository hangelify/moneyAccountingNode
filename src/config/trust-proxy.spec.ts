import { parseTrustProxy } from './trust-proxy';

describe('parseTrustProxy', () => {
  it.each([undefined, '', '   ', 'false', 'FALSE'])(
    'disables trust proxy for %p',
    (raw) => {
      expect(parseTrustProxy(raw)).toBe(false);
    },
  );

  it.each([
    ['0', 0],
    ['1', 1],
    [' 2 ', 2],
  ])('parses hop count %p', (raw, expected) => {
    expect(parseTrustProxy(raw)).toBe(expected);
  });

  it('parses a list of addresses, subnets and named ranges', () => {
    expect(
      parseTrustProxy('loopback, 10.0.0.0/8 ,192.168.1.10,fd00::/8,::1'),
    ).toEqual(['loopback', '10.0.0.0/8', '192.168.1.10', 'fd00::/8', '::1']);
  });

  it.each(['linklocal', 'uniquelocal'])('accepts named range %p', (raw) => {
    expect(parseTrustProxy(raw)).toEqual([raw]);
  });

  it('rejects "true" because it trusts a client-supplied X-Forwarded-For', () => {
    expect(() => parseTrustProxy('true')).toThrow(/TRUST_PROXY/);
  });

  it.each([
    '-1',
    '1.5',
    '1e2',
    'abc',
    'loopback,',
    'loopback,,10.0.0.0/8',
    '10.0.0.0/33',
    '10.0.0.0/abc',
    'fd00::/129',
    '300.0.0.1',
    '10.0.0.0/8/8',
  ])('rejects invalid value %p with a clear error', (raw) => {
    expect(() => parseTrustProxy(raw)).toThrow(
      new RegExp(`Invalid TRUST_PROXY value`),
    );
  });
});
