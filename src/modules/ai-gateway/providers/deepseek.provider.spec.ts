/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import OpenAI from 'openai';
import { DeepSeekProvider } from './deepseek.provider';
import { InvalidResponseError } from '../internal/error-classifier';
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

describe('DeepSeekProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCtor.mockClear();
  });

  it('is disabled when DEEPSEEK_API_KEY is missing', () => {
    delete process.env.DEEPSEEK_API_KEY;
    const p = new DeepSeekProvider(testAiCallConfig());
    expect(p.isConfigured).toBe(false);
  });

  it('exposes only text and json capabilities (no vision)', () => {
    process.env.DEEPSEEK_API_KEY = 'x';
    process.env.DEEPSEEK_MODEL = 'deepseek-chat';
    const p = new DeepSeekProvider(testAiCallConfig());
    expect(p.capabilities.has('text')).toBe(true);
    expect(p.capabilities.has('json')).toBe(true);
    expect(p.capabilities.has('vision')).toBe(false);
  });

  it('constructs OpenAI SDK with DeepSeek baseURL', () => {
    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.DEEPSEEK_MODEL = 'deepseek-chat';
    new DeepSeekProvider(testAiCallConfig());
    expect(mockCtor).toHaveBeenCalledWith({
      apiKey: 'ds-key',
      baseURL: 'https://api.deepseek.com',
      maxRetries: 0,
    });
  });

  it('appends schema to existing system message and sets json_object mode', async () => {
    process.env.DEEPSEEK_API_KEY = 'x';
    process.env.DEEPSEEK_MODEL = 'deepseek-chat';
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
      model: 'deepseek-chat',
    });
    const p = new DeepSeekProvider(testAiCallConfig());
    const res = await p.complete({
      messages: [
        { role: 'system', text: 'You are helpful.' },
        { role: 'user', text: 'classify' },
      ],
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    expect(res.json).toEqual({ ok: true });
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.response_format).toEqual({ type: 'json_object' });
    const systemMsg = arg.messages.find((m: any) => m.role === 'system');
    expect(systemMsg.content).toContain('You are helpful.');
    expect(systemMsg.content).toContain('JSON matching this schema');
  });

  it('synthesizes a system message when none is provided', async () => {
    process.env.DEEPSEEK_API_KEY = 'x';
    process.env.DEEPSEEK_MODEL = 'deepseek-chat';
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: 'deepseek-chat',
    });
    const p = new DeepSeekProvider(testAiCallConfig());
    await p.complete({
      messages: [{ role: 'user', text: 'classify' }],
      jsonSchema: { type: 'object' },
    });
    const arg = mockCreate.mock.calls[0][0];
    const systemMsgs = arg.messages.filter((m: any) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('helpful assistant');
    expect(systemMsgs[0].content).toContain('JSON matching this schema');
  });

  it('throws InvalidResponseError when the body is not valid JSON', async () => {
    process.env.DEEPSEEK_API_KEY = 'x';
    process.env.DEEPSEEK_MODEL = 'deepseek-chat';
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'not json {' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      model: 'deepseek-chat',
    });
    const p = new DeepSeekProvider(testAiCallConfig());
    await expect(
      p.complete({
        messages: [{ role: 'user', text: 'x' }],
        jsonSchema: { type: 'object' },
      }),
    ).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('classifies 429 as transient and 400 as non-transient', () => {
    process.env.DEEPSEEK_API_KEY = 'x';
    process.env.DEEPSEEK_MODEL = 'deepseek-chat';
    const p = new DeepSeekProvider(testAiCallConfig());
    expect(p.isTransient({ status: 429 })).toBe(true);
    expect(p.isTransient({ status: 400 })).toBe(false);
    expect(p.isTransient({ status: 503 })).toBe(true);
  });

  itBoundsSdkCalls({
    env: { DEEPSEEK_API_KEY: 'x', DEEPSEEK_MODEL: 'deepseek-chat' },
    make: (cfg) => new DeepSeekProvider(cfg),
    ctor: mockCtor,
    create: mockCreate,
    okResponse: { choices: [{ message: { content: '{}' } }] },
    connectionError: () => new OpenAI.APIConnectionError({}),
  });
});
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
