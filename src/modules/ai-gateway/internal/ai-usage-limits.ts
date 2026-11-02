import { readInt } from './ai-call-config';
import type { Env } from './ai-call-config';

export const AI_USAGE_LIMITS = Symbol('AI_USAGE_LIMITS');

export interface AiUsageLimits {
  /** AI requests one user may start per minute (`ai-minute` throttler). */
  userPerMinute: number;
  /** AI requests one user may start per 24 hours (`ai-day` throttler). */
  userPerDay: number;
  /** Spend of one user over the last 24 hours, in USD, before AI calls are refused. */
  dailyBudgetUsd: number;
  /** AI calls running at once in this process (not across instances). */
  maxConcurrency: number;
}

function readUsd(env: Env, name: string, def: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const value = /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid ${name}='${raw}': expected a positive decimal amount (default ${def})`,
    );
  }
  return value;
}

export function loadAiUsageLimits(env: Env = process.env): AiUsageLimits {
  return {
    userPerMinute: readInt(env, 'AI_USER_LIMIT_PER_MINUTE', 10, 1),
    userPerDay: readInt(env, 'AI_USER_LIMIT_PER_DAY', 100, 1),
    dailyBudgetUsd: readUsd(env, 'AI_DAILY_BUDGET_USD', 1),
    maxConcurrency: readInt(env, 'AI_MAX_CONCURRENCY', 4, 1),
  };
}
