import { Inject, Injectable } from '@nestjs/common';
import OpenAI from 'openai';
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
import { InvalidResponseError } from '../internal/error-classifier';

@Injectable()
export class DeepSeekProvider implements LlmProvider {
  readonly name: ProviderName = 'deepseek';
  readonly capabilities = new Set<Capability>(['text', 'json']);
  readonly isConfigured: boolean;
  readonly defaultModel: string;
  private readonly client?: OpenAI;

  constructor(@Inject(AI_CALL_CONFIG) private readonly config: AiCallConfig) {
    const key = readOptionalKey('DEEPSEEK_API_KEY');
    this.isConfigured = !!key;
    this.defaultModel =
      readModelWhenConfigured('DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL') ?? '';
    if (key) {
      this.client = new OpenAI({
        apiKey: key,
        baseURL: 'https://api.deepseek.com',
        maxRetries: 0,
      });
    }
  }

  async complete(req: LlmRequest, opts?: LlmCallOptions): Promise<LlmResponse> {
    if (!this.client) throw new Error('DeepSeekProvider is not configured');
    const model = req.modelOverride ?? this.defaultModel;

    const messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }> = req.messages.map((m) => {
      if (m.role === 'system') {
        return { role: 'system' as const, content: m.text };
      }
      if (m.role === 'assistant') {
        return { role: 'assistant' as const, content: m.text };
      }
      const images = m.images ?? [];
      if (images.length > 0) {
        throw new Error(
          'DeepSeekProvider does not support vision; images were provided on a user message',
        );
      }
      return { role: 'user' as const, content: m.text };
    });

    if (req.jsonSchema) {
      const suffix = `\n\nYou must return JSON matching this schema: ${JSON.stringify(
        req.jsonSchema,
      )}`;
      const systemIndex = messages.findIndex((m) => m.role === 'system');
      if (systemIndex >= 0) {
        messages[systemIndex] = {
          role: 'system',
          content: messages[systemIndex].content + suffix,
        };
      } else {
        messages.unshift({
          role: 'system',
          content: `You are a helpful assistant.${suffix}`,
        });
      }
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: req.temperature ?? 0,
    };
    if (req.maxOutputTokens !== undefined) {
      body.max_tokens = req.maxOutputTokens;
    }
    if (req.jsonSchema) {
      body.response_format = { type: 'json_object' };
    }

    const { config } = this;
    const response = await withRetry(
      (signal) =>
        this.client!.chat.completions.create(body as never, {
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

    const resp = response as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };

    const text = resp.choices?.[0]?.message?.content ?? '';
    const usage = {
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
    };
    let json: unknown;
    if (req.jsonSchema) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new InvalidResponseError(
          'DeepSeek returned non-JSON body',
          text,
          usage,
        );
      }
    }

    return { text, json, model: resp.model ?? model, usage };
  }

  isTransient(err: unknown): boolean {
    return isTransient(err);
  }
}
