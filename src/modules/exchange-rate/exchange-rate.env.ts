export const EXCHANGE_RATE_CONFIG = Symbol('EXCHANGE_RATE_CONFIG');

export interface ExchangeRateConfig {
  /** Base URL of the mdl.md API, without a trailing slash. */
  apiUrl: string;
  timeoutMs: number;
}

const DEFAULT_API_URL = 'https://mdl.md/api/v1';
const DEFAULT_TIMEOUT_MS = 10_000;

export function readExchangeRateConfig(): ExchangeRateConfig {
  const rawUrl = process.env.EXCHANGE_RATE_API_URL?.trim() || DEFAULT_API_URL;
  if (!/^https?:\/\//.test(rawUrl)) {
    throw new Error(
      `EXCHANGE_RATE_API_URL must be an http(s) URL, got "${rawUrl}"`,
    );
  }

  const rawTimeout = process.env.EXCHANGE_RATE_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(
      `EXCHANGE_RATE_TIMEOUT_MS must be a whole number of milliseconds >= 1, got "${rawTimeout}"`,
    );
  }

  return { apiUrl: rawUrl.replace(/\/+$/, ''), timeoutMs };
}
