import { BadRequestException } from '@nestjs/common';

/**
 * Rejects a bulk request whose names repeat case-insensitively, matching the
 * lower(name) unique indexes, before anything is written.
 */
export function assertUniqueNames(names: string[]): void {
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) dups.push(name);
    seen.add(key);
  }
  if (dups.length > 0) {
    throw new BadRequestException(
      `Duplicate names in request: ${dups.join(', ')}`,
    );
  }
}
