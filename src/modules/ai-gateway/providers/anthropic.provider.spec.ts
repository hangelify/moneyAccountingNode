/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from './anthropic.provider';
import {
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
  messages: { create: mockCreate },
}));
jest.mock('@anthropic-ai/sdk', () => {
  const actual =
    jest.requireActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
  // Keep the real static error classes for instanceof checks.
  const MockAnthropic: unknown = Object.setPrototypeOf(function (
    ...args: unknown[]
  ) {
    return mockCtor(...args);
  }, actual.default);
  return { __esModule: true, default: MockAnthropic };
});

describe('AnthropicProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('is disabled when ANTHROPIC_API_KEY is missing', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const p = new AnthropicProvider(testAiCallConfig());
    expect(p.isConfigured).toBe(false);
  });

  it('routes system messages to the system param and images as base64 blocks', async () => {
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    mockCreate.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'output', input: { ok: true } }],
      usage: { input_tokens: 5, output_tokens: 7 },
      model: 'claude-sonnet-4-6',
    });
    const p = new AnthropicProvider(testAiCallConfig());
    const res = await p.complete({
      messages: [
        { role: 'system', text: 'sys' },
        {
          role: 'user',
          text: 'look at this',
          images: [{ data: Buffer.from('img'), mediaType: 'image/png' }],
        },
      ],
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    expect(res.json).toEqual({ ok: true });
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.system).toBe('sys');
    expect(arg.tool_choice).toEqual({ type: 'tool', name: 'output' });
    const userBlocks = arg.messages[0].content;
    expect(userBlocks.some((b: any) => b.type === 'image')).toBe(true);
    const imageBlock = userBlocks.find((b: any) => b.type === 'image');
    expect(imageBlock.source.data).toBe(Buffer.from('img').toString('base64'));
  });

  describe('response handling', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'x';
      process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    });

    const jsonReq = {
      messages: [{ role: 'user' as const, text: 'x' }],
      jsonSchema: { type: 'object' },
    };

    it('passes maxOutputTokens and temperature into the request body', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', name: 'output', input: {} }],
        stop_reason: 'tool_use',
      });
      const p = new AnthropicProvider(testAiCallConfig());
      await p.complete({ ...jsonReq, maxOutputTokens: 1234, temperature: 0.3 });
      const arg = mockCreate.mock.calls[0][0];
      expect(arg.max_tokens).toBe(1234);
      expect(arg.temperature).toBe(0.3);
    });

    it('returns the tool input as raw text and the stop reason', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', name: 'output', input: { ok: true } }],
        stop_reason: 'tool_use',
      });
      const p = new AnthropicProvider(testAiCallConfig());
      const res = await p.complete(jsonReq);
      expect(res.text).toBe('{"ok":true}');
      expect(res.stopReason).toBe('tool_use');
    });

    it.each([
      ['missing', undefined],
      ['partial', { input_tokens: 5 }],
    ])('leaves usage undefined when it is %s', async (_label, usage) => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', name: 'output', input: {} }],
        stop_reason: 'tool_use',
        usage,
      });
      const p = new AnthropicProvider(testAiCallConfig());
      const res = await p.complete(jsonReq);
      expect(res.usage).toBeUndefined();
    });

    it('throws TruncatedResponseError with the raw body when max_tokens is hit', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', name: 'output', input: { items: [] } }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 5, output_tokens: 4096 },
      });
      const p = new AnthropicProvider(testAiCallConfig());
      const err: unknown = await p.complete(jsonReq).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TruncatedResponseError);
      expect(err).toMatchObject({
        raw: '{"items":[]}',
        usage: { inputTokens: 5, outputTokens: 4096 },
      });
    });

    it('throws RefusalError when the model refuses', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'I cannot help with that.' }],
        stop_reason: 'refusal',
        usage: { input_tokens: 5, output_tokens: 6 },
      });
      const p = new AnthropicProvider(testAiCallConfig());
      const err: unknown = await p.complete(jsonReq).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RefusalError);
      expect(err).toMatchObject({
        message: expect.stringContaining('refused'),
        raw: 'I cannot help with that.',
        usage: { inputTokens: 5, outputTokens: 6 },
      });
    });
  });

  it('classifies 429 as transient and 400 as non-transient', () => {
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
    const p = new AnthropicProvider(testAiCallConfig());
    expect(p.isTransient({ status: 429 })).toBe(true);
    expect(p.isTransient({ status: 400 })).toBe(false);
    expect(p.isTransient({ status: 503 })).toBe(true);
  });

  itBoundsSdkCalls({
    env: { ANTHROPIC_API_KEY: 'x', ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
    make: (cfg) => new AnthropicProvider(cfg),
    ctor: mockCtor,
    create: mockCreate,
    okResponse: {
      content: [{ type: 'tool_use', name: 'output', input: {} }],
    },
    connectionError: () => new Anthropic.APIConnectionError({}),
  });
});
