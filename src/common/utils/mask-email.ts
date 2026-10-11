import { normalizeEmail } from '../transforms/normalize-email';

/**
 * "alice@example.com" -> "a***@example.com": enough to tell accounts apart in
 * logs without storing the address, including ones typed by an attacker.
 */
export function maskEmail(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }
  return `${normalized[0]}***${normalized.slice(at)}`;
}
