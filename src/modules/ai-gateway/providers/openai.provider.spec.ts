import OpenAI from 'openai';
import { OpenAiProvider } from './openai.provider';
import {
  InvalidResponseError,
  RefusalError,
  TruncatedResponseError,
} from '../internal/error-classifier';
import {
  itBoundsSdkCalls,
  testAiCallConfig,
} from './__fixtures__/call-bounds.shared';

const mockCreate = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockCtor = jest.fn((..._args: unknown[]) => ({
  chat: { completions: { create: mockCreate } },
}));
jest.mock('openai', () => {
  const actual = jest.requireActual<typeof import('openai')>('openai');
  // Keep the real static error classes for instanceof checks.
  const MockOpenAI: unknown = Object.setPrototypeOf(function (
    ...args: unknown[]
  ) {
    return mockCtor(...args);
  }, actual.default);
  return { __esModule: true, default: MockOpenAI };
});

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
describe('OpenAiProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('is disabled when OPENAI_API_KEY is missing', () => {
    delete process.env.OPENAI_API_KEY;
    const p = new OpenAiProvider(testAiCallConfig());
    expect(p.isConfigured).toBe(false);
  });

  it('uses response_format json_schema and encodes images as data URLs', async () => {
    process.env.OPENAI_API_KEY = 'x';
    process.env.OPENAI_MODEL = 'gpt-4o';
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
      model: 'gpt-4o',
    });
    const p = new OpenAiProvider(testAiCallConfig());
    const res = await p.complete({
      messages: [
        { role: 'system', text: 'sys' },
        {
          role: 'user',
          text: 'look',
          images: [{ data: Buffer.from('img'), mediaType: 'image/png' }],
        },
      ],
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    expect(res.json).toEqual({ ok: true });
    expect(res.text).toBe('{"ok":true}');
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'output',
        strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    });
    const userBlocks = arg.messages.find((m: any) => m.role === 'user').content;
    const imageBlock = userBlocks.find((b: any) => b.type === 'image_url');
    expect(imageBlock.image_url.url).toBe(
      `data:image/png;base64,${Buffer.from('img').toString('base64')}`,
    );
  });

  it('throws InvalidResponseError carrying the paid usage and raw body on non-JSON content', async () => {
    process.env.OPENAI_API_KEY = 'x';
    process.env.OPENAI_MODEL = 'gpt-4o';
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'not json {' } }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
      model: 'gpt-4o',
    });
    const p = new OpenAiProvider(testAiCallConfig());
    const err: unknown = await p
      .complete({
        messages: [{ role: 'user', text: 'x' }],
        jsonSchema: { type: 'object' },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidResponseError);
    expect(err).toMatchObject({
      raw: 'not json {',
      usage: { inputTokens: 5, outputTokens: 7 },
    });
  });

  describe('response handling', () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'x';
      process.env.OPENAI_MODEL = 'gpt-4o';
    });

    const jsonReq = {
      messages: [{ role: 'user' as const, text: 'x' }],
      jsonSchema: { type: 'object' },
    };

    it('sends maxOutputTokens as max_completion_tokens with the temperature', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      });
      const p = new OpenAiProvider(testAiCallConfig());
      const res = await p.complete({
        ...jsonReq,
        maxOutputTokens: 1234,
        temperature: 0.3,
      });
      const arg = mockCreate.mock.calls[0][0];
      expect(arg.max_completion_tokens).toBe(1234);
      expect(arg).not.toHaveProperty('max_tokens');
      expect(arg.temperature).toBe(0.3);
      expect(res.stopReason).toBe('stop');
    });

    it('omits temperature and the token limit when the request sets none', async () => {
      // Reasoning models (o-series, gpt-5) reject a non-default temperature.
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      });
      const p = new OpenAiProvider(testAiCallConfig());
      await p.complete(jsonReq);
      const arg = mockCreate.mock.calls[0][0];
      expect(arg).not.toHaveProperty('temperature');
      expect(arg).not.toHaveProperty('max_completion_tokens');
      expect(arg).not.toHaveProperty('max_tokens');
    });

    it('throws TruncatedResponseError with the raw body on finish_reason length', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          { message: { content: '{"items":[' }, finish_reason: 'length' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4096 },
      });
      const p = new OpenAiProvider(testAiCallConfig());
      const err: unknown = await p.complete(jsonReq).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TruncatedResponseError);
      expect(err).toMatchObject({
        raw: '{"items":[',
        usage: { inputTokens: 5, outputTokens: 4096 },
      });
    });

    it('throws RefusalError carrying the refusal text', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: { content: null, refusal: 'I cannot help with that.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 6 },
      });
      const p = new OpenAiProvider(testAiCallConfig());
      const err: unknown = await p.complete(jsonReq).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RefusalError);
      expect(err).toMatchObject({
        message: expect.stringContaining('I cannot help with that.'),
        raw: 'I cannot help with that.',
        usage: { inputTokens: 5, outputTokens: 6 },
      });
    });
  });

  it('classifies 429/5xx as transient, 4xx otherwise as non-transient', () => {
    process.env.OPENAI_API_KEY = 'x';
    process.env.OPENAI_MODEL = 'gpt-4o';
    const p = new OpenAiProvider(testAiCallConfig());
    expect(p.isTransient({ status: 429 })).toBe(true);
    expect(p.isTransient({ status: 503 })).toBe(true);
    expect(p.isTransient({ status: 400 })).toBe(false);
    expect(p.isTransient({ status: 401 })).toBe(false);
  });

  itBoundsSdkCalls({
    env: { OPENAI_API_KEY: 'x', OPENAI_MODEL: 'gpt-4o' },
    make: (cfg) => new OpenAiProvider(cfg),
    ctor: mockCtor,
    create: mockCreate,
    okResponse: { choices: [{ message: { content: '{}' } }] },
    connectionError: () => new OpenAI.APIConnectionError({}),
  });
});
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
