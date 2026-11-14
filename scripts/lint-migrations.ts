/**
 * Migration safety check (HAN-120), run in CI:
 *
 * 1. Applied migrations are immutable: a migration file that exists on the
 *    base ref may not be changed, renamed or deleted (the snapshot may).
 * 2. New migrations are linted by Squawk: their up() SQL is collected from
 *    addSql() and checked for statements that lock or break a live table.
 *
 * Base ref: MIGRATIONS_BASE (CI passes the PR base or the previous push),
 * default origin/dev. Run locally: MIGRATIONS_BASE=dev npm run migrations:lint
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Migration } from '@mikro-orm/migrations';

const MIGRATIONS_DIR = 'src/migrations';
const FALLBACK_BASE = 'origin/dev';
const requestedBase = process.env['MIGRATIONS_BASE'] ?? FALLBACK_BASE;

type MigrationClass = new (driver: never, config: never) => Migration;

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function isCommit(ref: string): boolean {
  try {
    git(['cat-file', '-e', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commit to compare with, or null when there is none (first push of a
 * branch). After a force push `github.event.before` is gone from the
 * repository, so fall back to origin/dev instead of failing for good.
 */
function resolveBase(): string | null {
  if (/^0+$/.test(requestedBase)) return null;
  if (isCommit(requestedBase)) return requestedBase;
  if (requestedBase !== FALLBACK_BASE && isCommit(FALLBACK_BASE)) {
    console.warn(
      `Base ${requestedBase} is not in this repository (force push?); comparing with ${FALLBACK_BASE}.`,
    );
    return FALLBACK_BASE;
  }
  throw new Error(
    `Neither ${requestedBase} nor ${FALLBACK_BASE} is a commit here.`,
  );
}

function changedMigrationFiles(base: string): {
  added: string[];
  touched: string[];
} {
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  const lines = git([
    'diff',
    '--name-status',
    '--no-renames',
    mergeBase,
    '--',
    `${MIGRATIONS_DIR}/*.ts`,
  ])
    .split('\n')
    .filter(Boolean);
  const added: string[] = [];
  const touched: string[] = [];
  for (const line of lines) {
    const [status = '', file = ''] = line.split('\t');
    if (status === 'A') added.push(file);
    else touched.push(`${status} ${file}`);
  }
  // Uncommitted new files count as added when run locally.
  const untracked = git([
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    `${MIGRATIONS_DIR}/*.ts`,
  ])
    .split('\n')
    .filter(Boolean);
  return { added: [...added, ...untracked], touched };
}

async function upSql(file: string): Promise<{ sql: string; inTx: boolean }> {
  const mod = (await import(resolve(file))) as Record<string, unknown>;
  const Cls = Object.values(mod).find(
    (v): v is MigrationClass =>
      typeof v === 'function' && v.prototype instanceof Migration,
  );
  if (!Cls) throw new Error(`${file}: no class extending Migration exported`);
  // addSql() only collects strings, so no driver or config is needed.
  const migration = new Cls(undefined as never, undefined as never);
  try {
    await migration.up();
  } catch (err) {
    throw new Error(
      `${file}: up() must only call addSql() to be checked here (${String(err)})`,
      { cause: err },
    );
  }
  const statements = migration.getQueries().map((q) => {
    if (typeof q !== 'string') {
      throw new Error(`${file}: only string addSql() is supported here`);
    }
    return q.trim().endsWith(';') ? q.trim() : `${q.trim()};`;
  });
  return {
    sql: statements.join('\n') + '\n',
    inTx: migration.isTransactional(),
  };
}

/** Writes each migration's up() SQL into dir and runs Squawk; true = issues. */
async function squawk(dir: string, added: string[]): Promise<boolean> {
  const groups: Record<'tx' | 'noTx', string[]> = { tx: [], noTx: [] };
  for (const file of added) {
    const { sql, inTx } = await upSql(file);
    const out = join(dir, basename(file, '.ts') + '.sql');
    writeFileSync(out, sql);
    groups[inTx ? 'tx' : 'noTx'].push(out);
  }
  let failed = false;
  for (const [kind, files] of Object.entries(groups)) {
    if (files.length === 0) continue;
    const args = ['--config', '.squawk.toml', ...files];
    // MikroORM wraps a migration in a transaction unless it overrides
    // isTransactional() to return false.
    if (kind === 'tx') args.unshift('--assume-in-transaction');
    try {
      execFileSync('squawk', args, { stdio: 'inherit' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('squawk is not installed: run npm ci (squawk-cli).', {
          cause: err,
        });
      }
      failed = true;
    }
  }
  return failed;
}

async function main(): Promise<void> {
  const base = resolveBase();
  if (base === null) {
    console.log('No base commit (first push of a branch): nothing to compare.');
    return;
  }
  const { added, touched } = changedMigrationFiles(base);

  if (touched.length > 0) {
    console.error(
      `Applied migrations must not change (compared with ${base}):\n` +
        touched.map((t) => `  ${t}`).join('\n') +
        '\nRevert these files and add a new migration with the change instead.',
    );
    process.exit(1);
  }
  if (added.length === 0) {
    console.log(`No new migrations compared with ${base}.`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'squawk-'));
  let failed: boolean;
  try {
    failed = await squawk(dir, added);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failed) {
    console.error(
      '\nSee README, "Database Migrations": build indexes CONCURRENTLY in a migration of ' +
        'their own with isTransactional() returning false.',
    );
    process.exit(1);
  }
  console.log(`Squawk: ${String(added.length)} new migration(s) are safe.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
