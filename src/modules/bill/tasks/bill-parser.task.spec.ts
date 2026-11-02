import { BillParserTask } from './bill-parser.task';

describe('BillParserTask', () => {
  const t = new BillParserTask();

  it('declares text + vision + json capabilities', () => {
    expect(t.requiredCapabilities.has('vision')).toBe(true);
    expect(t.requiredCapabilities.has('json')).toBe(true);
    expect(t.requiredCapabilities.has('text')).toBe(true);
  });

  // The model and output limit come from the provider's env settings.
  it('names itself bill.parse and leaves model and output limit to the provider', () => {
    expect(t.name).toBe('bill.parse');
    expect(t.modelOverrides).toBeUndefined();
    expect(t.maxOutputTokens).toBeUndefined();
  });

  it('produces a user message with the image attached', async () => {
    const buf = Buffer.from('x');
    const req = await t.buildRequest({ image: buf, mediaType: 'image/png' });
    const user = req.messages.find((m) => m.role === 'user');
    expect(user).toBeDefined();
    if (user && user.role === 'user') {
      expect(user.images?.[0].data).toBe(buf);
      expect(user.images?.[0].mediaType).toBe('image/png');
    }
  });

  it('does not ask the model for the full OCR text', async () => {
    const req = await t.buildRequest({
      image: Buffer.from('x'),
      mediaType: 'image/png',
    });
    const system = req.messages.find((m) => m.role === 'system');
    expect(system?.text).not.toContain('raw_extracted_text');
  });

  it('rejects bad input at parse time', () => {
    expect(() =>
      t.inputSchema.parse({ image: 'not a buffer', mediaType: 'image/png' }),
    ).toThrow();
  });
});
