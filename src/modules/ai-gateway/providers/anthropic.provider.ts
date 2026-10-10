import { Inject, Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { Capability } from '../types/capability';
import {
  LlmCallOptions,
  LlmProvider,
  ProviderName,
} from '../types/llm-provider';
import { LlmRequest, LlmResponse } from '../types/llm-request';
import { readOptionalKey, readModelWhenConfigured } from './provider.env';
import { withRetry } from '../internal/retry';
import { AI_CALL_CONFIG } from '../internal/ai-call-config';
import type { AiCallConfig } from '../internal/ai-call-config';
import { isTransient, retryAfterMs } from '../internal/transient';

@Injectable()
export class AnthropicProvider implements LlmProvider {
  readonly name: ProviderName = 'anthropic';
  readonly capabilities = new Set<Capability>(['text', 'vision', 'json']);
  readonly isConfigured: boolean;
  readonly defaultModel: string;
  private readonly client?: Anthropic;

  constructor(@Inject(AI_CALL_CONFIG) private readonly config: AiCallConfig) {
    const key = readOptionalKey('ANTHROPIC_API_KEY');
    this.isConfigured = !!key;
    this.defaultModel =
      readModelWhenConfigured('ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL') ?? '';
    if (key) this.client = new Anthropic({ apiKey: key, maxRetries: 0 });
  }

  async complete(req: LlmRequest, opts?: LlmCallOptions): Promise<LlmResponse> {
    if (!this.client) throw new Error('AnthropicProvider is not configured');
    const model = req.modelOverride ?? this.defaultModel;
    const system =
      req.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.text)
        .join('\n') || undefined;

    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'assistant') {
          return {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: m.text }],
          };
        }
        const u = m; // role: 'user'
        const blocks: unknown[] = [];
        for (const img of u.images ?? []) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mediaType,
              data: img.data.toString('base64'),
            },
          });
        }
        blocks.push({ type: 'text', text: u.text });
        return { role: 'user' as const, content: blocks };
      });

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxOutputTokens ?? 4096,
      temperature: req.temperature ?? 0,
      system,
      messages,
    };

    if (req.jsonSchema) {
      body.tools = [
        {
          name: 'output',
          description: 'Return the structured output.',
          input_schema: req.jsonSchema,
        },
      ];
      body.tool_choice = { type: 'tool', name: 'output' };
    }

    const { config } = this;
    const response = await withRetry(
      (signal) =>
        this.client!.messages.create(body as never, {
          signal,
          timeout: config.callTimeoutMs,
        }),
      isTransient,
      {
        attempts: config.retryAttempts + 1,
        backoffMs: config.retryBackoffMs,
        maxBackoffMs: config.maxBackoffMs,
        timeoutMs: config.callTimeoutMs,
        signal: opts?.signal,
        retryAfterMs,
        maxRetryAfterMs: config.maxRetryAfterMs,
      },
    );

    let text = '';
    let json: unknown;
    const resp = response as {
      content?: Array<{
        type: string;
        text?: string;
        name?: string;
        input?: unknown;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };
    for (const block of resp.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string')
        text += block.text;
      if (block.type === 'tool_use' && block.name === 'output')
        json = block.input;
    }

    return {
      text,
      json,
      model: resp.model ?? model,
      usage: {
        inputTokens: resp.usage?.input_tokens ?? 0,
        outputTokens: resp.usage?.output_tokens ?? 0,
      },
    };
  }

  isTransient(err: unknown): boolean {
    return isTransient(err);
  }
}
