import { ServiceUnavailableException } from '@nestjs/common';
import { MdlMdClient } from './mdl-md.client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MdlMdClient', () => {
  const client = new MdlMdClient({
    apiUrl: 'https://mdl.md/api/v1',
    timeoutMs: 1000,
  });
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchSpy.mockRestore());

  it('requests the day and returns its rates', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        success: true,
        date: '2026-10-30',
        source: 'BNM',
        rates: [
          { currency: 'EUR', rate: 20.0954, nominal: 1, change_value: -0.03 },
          { currency: 'HUF', rate: 0.0549, nominal: 100 },
        ],
      }),
    );

    const day = await client.fetchDay('2026-10-30');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://mdl.md/api/v1/rates/2026-10-30',
      expect.objectContaining({
        signal: expect.any(AbortSignal) as unknown,
      }),
    );
    expect(day).toEqual({
      date: '2026-10-30',
      rates: [
        { currency: 'EUR', rate: 20.0954, nominal: 1 },
        { currency: 'HUF', rate: 0.0549, nominal: 100 },
      ],
    });
  });

  it('returns null when the day has no rates yet', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ success: true, date: '2026-11-01', rates: [] }),
    );
    await expect(client.fetchDay('2026-11-01')).resolves.toBeNull();
  });

  it('returns null on 404', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ success: false, error: 'no rates' }, 404),
    );
    await expect(client.fetchDay('2026-10-30')).resolves.toBeNull();
  });

  it.each([429, 500, 503])('fails as unavailable on HTTP %d', async (code) => {
    fetchSpy.mockResolvedValue(jsonResponse({ success: false }, code));
    await expect(client.fetchDay('2026-10-30')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('fails as unavailable on a network error or timeout', async () => {
    fetchSpy.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(client.fetchDay('2026-10-30')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it.each([
    ['success false', { success: false, error: 'x' }],
    ['rates missing', { success: true, date: '2026-10-30' }],
    ['another day', { success: true, date: '2026-10-29', rates: [] }],
    [
      'rate as a string',
      {
        success: true,
        date: '2026-10-30',
        rates: [{ currency: 'EUR', rate: '20.09', nominal: 1 }],
      },
    ],
    [
      'zero rate',
      {
        success: true,
        date: '2026-10-30',
        rates: [{ currency: 'EUR', rate: 0, nominal: 1 }],
      },
    ],
    [
      'bad currency code',
      {
        success: true,
        date: '2026-10-30',
        rates: [{ currency: 'euro', rate: 20, nominal: 1 }],
      },
    ],
    [
      'fractional nominal',
      {
        success: true,
        date: '2026-10-30',
        rates: [{ currency: 'EUR', rate: 20, nominal: 1.5 }],
      },
    ],
  ])('rejects a malformed body (%s)', async (_label, body) => {
    fetchSpy.mockResolvedValue(jsonResponse(body));
    await expect(client.fetchDay('2026-10-30')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('rejects a body that is not JSON', async () => {
    fetchSpy.mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(client.fetchDay('2026-10-30')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
