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
import {
  InvalidResponseError,
  RefusalError,
  TruncatedResponseError,
} from '../internal/error-classifier';

@Injectable()
export class OpenAiProvider implements LlmProvider {
  readonly name: ProviderName = 'openai';
  readonly capabilities = new Set<Capability>(['text', 'vision', 'json']);
  readonly isConfigured: boolean;
  readonly defaultModel: string;
  private readonly client?: OpenAI;

  constructor(@Inject(AI_CALL_CONFIG) private readonly config: AiCallConfig) {
    const key = readOptionalKey('OPENAI_API_KEY');
    this.isConfigured = !!key;
    this.defaultModel =
      readModelWhenConfigured('OPENAI_API_KEY', 'OPENAI_MODEL') ?? '';
    if (key) this.client = new OpenAI({ apiKey: key, maxRetries: 0 });
  }

  async complete(req: LlmRequest, opts?: LlmCallOptions): Promise<LlmResponse> {
    if (!this.client) throw new Error('OpenAiProvider is not configured');
    const model = req.modelOverride ?? this.defaultModel;

    const messages = req.messages.map((m) => {
      if (m.role === 'system') {
        return { role: 'system' as const, content: m.text };
      }
      if (m.role === 'assistant') {
        return { role: 'assistant' as const, content: m.text };
      }
      const images = m.images ?? [];
      if (images.length === 0) {
        return { role: 'user' as const, content: m.text };
      }
      const blocks: unknown[] = [{ type: 'text', text: m.text }];
      for (const img of images) {
        blocks.push({
          type: 'image_url',
          image_url: {
            url: `data:${img.mediaType};base64,${img.data.toString('base64')}`,
          },
        });
      }
      return { role: 'user' as const, content: blocks };
    });

    // Reasoning models (o-series, gpt-5) reject `max_tokens`, so the limit
    // goes as `max_completion_tokens`. They also reject a non-default
    // temperature: it is sent only when set, so a task meant for such a model
    // must leave it unset.
    const body: Record<string, unknown> = { model, messages };
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }
    if (req.maxOutputTokens !== undefined) {
      body.max_completion_tokens = req.maxOutputTokens;
    }

    if (req.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'output',
          strict: true,
          schema: req.jsonSchema,
        },
      };
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
      choices?: Array<{
        message?: { content?: string | null; refusal?: string | null };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };

    const choice = resp.choices?.[0];
    const text = choice?.message?.content ?? '';
    const refusal = choice?.message?.refusal;
    const stopReason = choice?.finish_reason ?? undefined;
    const usage = {
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
    };
    if (refusal) {
      throw new RefusalError(
        `OpenAI model refused to answer: ${refusal}`,
        refusal,
        usage,
      );
    }
    if (stopReason === 'content_filter') {
      throw new RefusalError(
        'OpenAI refused the answer: stopped by the content filter',
        text,
        usage,
      );
    }
    if (stopReason === 'length') {
      throw new TruncatedResponseError(
        'OpenAI stopped at the output token limit (finish_reason=length)',
        text,
        usage,
      );
    }
    let json: unknown;
    if (req.jsonSchema) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new InvalidResponseError(
          'OpenAI returned non-JSON content',
          text,
          usage,
        );
      }
    }

    return { text, json, model: resp.model ?? model, usage, stopReason };
  }

  isTransient(err: unknown): boolean {
    return isTransient(err);
  }
}
