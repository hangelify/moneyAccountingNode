import { isIP } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';

export type TrustProxySetting = false | number | string[];

const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function invalid(raw: string, reason: string): Error {
  return new Error(
    `Invalid TRUST_PROXY value "${raw}": ${reason}. ` +
      'Use a hop count (e.g. "1"), a comma-separated list of addresses/subnets ' +
      '(e.g. "loopback, 10.0.0.0/8") or "false".',
  );
}

function isValidProxyEntry(entry: string): boolean {
  if (NAMED_RANGES.has(entry)) return true;

  const [address = '', prefixText, ...rest] = entry.split('/');
  if (rest.length > 0) return false;

  const version = isIP(address);
  if (version === 0) return false;
  if (prefixText === undefined) return true;

  if (!/^\d+$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  return prefix <= (version === 4 ? 32 : 128);
}

/**
 * Parses TRUST_PROXY into a value for Express' `trust proxy` setting.
 * Unset/empty means "do not trust X-Forwarded-For". `true` is rejected on
 * purpose: Express would then take req.ip from the client-supplied header.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = raw?.trim() ?? '';
  if (value === '' || value.toLowerCase() === 'false') return false;

  if (value.toLowerCase() === 'true') {
    throw invalid(
      value,
      'trusting every proxy lets clients spoof their IP via X-Forwarded-For',
    );
  }

  if (/^\d+$/.test(value)) return Number(value);

  const entries = value.split(',').map((entry) => entry.trim());
  const bad = entries.find((entry) => !isValidProxyEntry(entry));
  if (bad !== undefined) {
    throw invalid(
      value,
      `"${bad}" is not an IP address, subnet or named range`,
    );
  }
  return entries;
}

export function applyTrustProxy(
  app: NestExpressApplication,
  setting: TrustProxySetting,
): void {
  app.set('trust proxy', setting);
}
