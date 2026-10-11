import type { Env } from './ai-call-config';

export const AI_REQUIRED = Symbol('AI_REQUIRED');

/**
 * Whether startup fails when an AI task has no capable provider
 * (`AI_REQUIRED`, default: true in production only). When false the app
 * boots without AI and the AI endpoints answer 503.
 */
export function loadAiRequired(env: Env = process.env): boolean {
  const raw = env.AI_REQUIRED?.trim();
  if (raw === undefined || raw === '') return env.NODE_ENV === 'production';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(
    `Invalid AI_REQUIRED='${env.AI_REQUIRED}': expected 'true' or 'false'`,
  );
}
