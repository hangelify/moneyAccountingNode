import { isIP } from 'node:net';

/** Matches the `varchar(45)` width of every `ip_address` column. */
const MAX_IP_LENGTH = 45;

/**
 * Returns the value only if it is a valid IPv4/IPv6 address that fits the
 * `ip_address` columns; otherwise null. `req.ip` may come from a
 * client-controlled X-Forwarded-For header, so never persist it unchecked.
 */
export function sanitizeIp(ip: string | null | undefined): string | null {
  if (!ip || ip.length > MAX_IP_LENGTH) return null;
  return isIP(ip) ? ip : null;
}
