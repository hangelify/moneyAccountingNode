export const AI_CALL_CONFIG = Symbol('AI_CALL_CONFIG');

export interface AiCallConfig {
  /** Hard timeout of a single HTTP call to a provider. */
  callTimeoutMs: number;
  /** Extra tries on the same provider after a transient error. */
  retryAttempts: number;
  /** Base for exponential backoff with full jitter. */
  retryBackoffMs: number;
  /** Upper bound of a single backoff delay. */
  maxBackoffMs: number;
  /** Upper bound for a provider-supplied `retry-after`. */
  maxRetryAfterMs: number;
  /** Total budget of one `AiGatewayService.run`, across all providers. */
  taskDeadlineMs: number;
  /** Do not start another provider when less than this is left. */
  minAttemptBudgetMs: number;
}

type Env = Record<string, string | undefined>;

function readInt(env: Env, name: string, def: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(
      `Invalid ${name}='${raw}': expected an integer >= ${min} (default ${def})`,
    );
  }
  return value;
}

const MIN_ATTEMPT_BUDGET_MS = 5_000;

export function loadAiCallConfig(env: Env = process.env): AiCallConfig {
  return {
    callTimeoutMs: readInt(env, 'AI_CALL_TIMEOUT_MS', 60_000, 1),
    retryAttempts: readInt(env, 'AI_TRANSIENT_RETRY_ATTEMPTS', 2, 0),
    retryBackoffMs: readInt(env, 'AI_TRANSIENT_RETRY_BACKOFF_MS', 500, 0),
    maxBackoffMs: 8_000,
    maxRetryAfterMs: 10_000,
    // A shorter deadline would leave no room for even one useful attempt.
    taskDeadlineMs: readInt(
      env,
      'AI_TASK_DEADLINE_MS',
      90_000,
      MIN_ATTEMPT_BUDGET_MS,
    ),
    minAttemptBudgetMs: MIN_ATTEMPT_BUDGET_MS,
  };
}
