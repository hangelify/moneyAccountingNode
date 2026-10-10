import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const TRANSIENT_STATUSES = new Set([408, 409, 429]);

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown; statusCode?: unknown };
  const s = e.status ?? e.statusCode;
  return typeof s === 'number' ? s : undefined;
}

/**
 * Shared retry classification for all providers. Timeouts are deliberately
 * NOT transient: a timed-out generation was most likely billed, so we fail
 * over to the next provider instead of paying for it again.
 */
export function isTransient(err: unknown): boolean {
  if (
    err instanceof Anthropic.APIConnectionTimeoutError ||
    err instanceof OpenAI.APIConnectionTimeoutError
  ) {
    return false;
  }
  if (
    err instanceof Anthropic.APIConnectionError ||
    err instanceof OpenAI.APIConnectionError
  ) {
    return true;
  }
  const s = statusOf(err);
  if (s === undefined) return false;
  return TRANSIENT_STATUSES.has(s) || (s >= 500 && s < 600);
}

function header(err: unknown, name: string): string | undefined {
  const headers = (err as { headers?: unknown } | undefined)?.headers;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return undefined;
}

/** Delay requested by a 429 response, in ms; undefined when absent/unparseable. */
export function retryAfterMs(err: unknown): number | undefined {
  if (statusOf(err) !== 429) return undefined;

  const rawMs = header(err, 'retry-after-ms');
  if (rawMs !== undefined && Number.isFinite(Number(rawMs))) {
    return Math.max(0, Number(rawMs));
  }

  const raw = header(err, 'retry-after');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
