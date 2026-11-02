import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { resolveClientMode } from './client-mode';

const req = (headers: Record<string, string>) => ({
  get: (name: string) => headers[name.toLowerCase()],
});

describe('resolveClientMode', () => {
  const original = process.env.FRONTEND_URL;
  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://app.example.com/';
  });
  afterAll(() => {
    process.env.FRONTEND_URL = original;
  });

  it('returns mobile for X-Client-Type: mobile without Origin', () => {
    expect(resolveClientMode(req({ 'x-client-type': 'Mobile' }))).toBe(
      'mobile',
    );
  });

  it('rejects mobile mode when the request carries an Origin', () => {
    expect(() =>
      resolveClientMode(
        req({ 'x-client-type': 'mobile', origin: 'https://app.example.com' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects unknown client types', () => {
    expect(() =>
      resolveClientMode(req({ 'x-client-type': 'desktop' })),
    ).toThrow(BadRequestException);
  });

  it('returns web for the frontend origin', () => {
    expect(resolveClientMode(req({ origin: 'https://app.example.com' }))).toBe(
      'web',
    );
  });

  it('returns web for a same-origin request', () => {
    expect(
      resolveClientMode(
        req({ origin: 'http://localhost:3000', host: 'localhost:3000' }),
      ),
    ).toBe('web');
  });

  it.each([
    [
      'a foreign origin',
      { origin: 'https://evil.example', host: 'api.example.com' },
    ],
    ['a missing origin', { host: 'api.example.com' }],
    ['a null origin', { origin: 'null', host: 'api.example.com' }],
    ['a malformed origin', { origin: 'not a url', host: 'api.example.com' }],
  ])('rejects web mode with %s', (_label, headers) => {
    expect(() => resolveClientMode(req(headers))).toThrow(ForbiddenException);
  });
});
