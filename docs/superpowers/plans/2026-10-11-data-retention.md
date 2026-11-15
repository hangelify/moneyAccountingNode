# P33 Data Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Purge expired auth rows, scrub raw AI-audit payloads after N days, stop triplicating OCR, and key S3 receipt images by household.

**Architecture:** New `RetentionModule` with one daily `@Cron` job; each batch runs in its own transaction guarded by `pg_try_advisory_xact_lock` so only one instance works at a time. Gateway/logger stop persisting duplicates and record `household_id`; storage keys gain a household prefix.

**Tech Stack:** NestJS 11, `@nestjs/schedule` (already registered in `AppModule`), MikroORM 6 + PostgreSQL 16, Jest (`*.spec.ts` via `npm test`, `*.int-spec.ts` via `npm run test:e2e`).

**Spec:** `docs/superpowers/specs/2026-10-11-data-retention-design.md`

## Global Constraints

- `logs` table is never purged.
- AI audit rows are never deleted; only `ai_requests.prompt`, `ai_requests.final_output`, `ai_request_attempts.raw_response_text`, `ai_request_attempts.parsed_json` are nulled.
- Env (integer >= 1): `REFRESH_TOKEN_RETENTION_DAYS=7`, `SESSION_RETENTION_DAYS=30`, `AI_AUDIT_RAW_RETENTION_DAYS=30`.
- New image key: `ai/images/{householdId}/{sha256}.{ext}`; no household -> legacy `ai/images/{sha256}.{ext}`.
- Code comments, test names, commit messages in English. Single commit at the end (pipeline rule) — no per-task commits.
- S3 lifecycle is documentation only.

## Review Focus

- Second instance running the job concurrently must skip, not double-work or error -> lock contention int test (Task 4).
- PENDING AI rows older than the cutoff must not be scrubbed (sweeper owns them) -> int test (Task 4).
- Active session past the cutoff but not expired must survive; expired-but-recent must survive -> int test (Task 4).
- Batch loop must terminate when rows < batch size and process more than one batch -> int test with batch size 2 (Task 4).
- Stale-PENDING sweeper must still close a parent with a SUCCESS attempt even though `parsed_json` is no longer stored -> existing logger int test adjusted (Task 2).

---

### Task 1: Migration + entity changes

**Files:**
- Create: `src/migrations/Migration20261011170000_AddDataRetentionColumnsAndIndexes.ts`
- Modify: `src/entities/ai-request.entity.ts` (prompt nullable, `household` ManyToOne, partial index), `src/entities/refresh-token.entity.ts` (`@Index()` on `expires_at`), `src/entities/session.entity.ts` (`@Index()` on `absolute_expires_at`), `src/migrations/.snapshot-accounting.json` (regenerate, never print)
- Test: `test/db-indexes.int-spec.ts` (add expectations if that file lists indexes)

**Produces:** `AiRequest.household?: Rel<Household>`, `AiRequest.prompt?: {...} | null`.

- [ ] Step 1: Migration `up`:
```sql
alter table "ai_requests" alter column "prompt" drop not null;
alter table "ai_requests" add column "household_id" uuid null;
alter table "ai_requests" add constraint "ai_requests_household_id_foreign"
  foreign key ("household_id") references "households" ("id") on update cascade on delete set null;
create index "ai_requests_household_id_index" on "ai_requests" ("household_id");
create index "ai_requests_unscrubbed_created_index" on "ai_requests" ("created_at") where "prompt" is not null;
create index "refresh_tokens_expires_at_index" on "refresh_tokens" ("expires_at");
create index "sessions_absolute_expires_at_index" on "sessions" ("absolute_expires_at");
```
`down` drops the four indexes, FK, column; then `update "ai_requests" set "prompt" = '{"messages":[]}' where "prompt" is null;` and `alter column "prompt" set not null`.
- [ ] Step 2: Entity changes mirroring the SQL (index names identical; partial index via `expression` like `ai_requests_pending_index`).
- [ ] Step 3: `npm run migration:up && npm run migration:down && npm run migration:up`; regenerate snapshot (`npx mikro-orm migration:create --dump` style check: `npx mikro-orm schema:update --dump` must print no diff). Check only `git diff --stat` on the snapshot.
- [ ] Step 4: `npm run type-check`.

### Task 2: Stop triplicating OCR

**Files:**
- Modify: `src/modules/ai-gateway/ai-gateway.service.ts:292-299` (success `finishAttempt` omits `rawText`/`parsedJson`)
- Modify: `src/modules/ai-gateway/internal/ai-request-logger.ts` `failStalePending` — remove the `final_output = (SELECT a.parsed_json ...)` line (nothing to copy any more)
- Test: `src/modules/ai-gateway/ai-gateway.service.int-spec.ts`, `src/modules/ai-gateway/internal/ai-request-logger.int-spec.ts`

- [ ] Step 1: In the gateway int-spec success case, add:
```ts
const attempt = await em.findOneOrFail(AiRequestAttempt, { id: parent.chosen_attempt_id! });
expect(attempt.raw_response_text).toBeNull();
expect(attempt.parsed_json).toBeNull();
expect(parent.final_output).toEqual(expectedOutput);
```
And for a schema-invalid attempt keep asserting `raw_response_text` is stored.
- [ ] Step 2: Run `npx jest --config test/jest-e2e.json src/modules/ai-gateway/ai-gateway.service.int-spec.ts` -> FAIL.
- [ ] Step 3: Change success call to:
```ts
await finishAttempt({
  status: AiAttemptStatus.SUCCESS,
  // The parsed result is stored once, as the request's final_output.
  inputTokens: res.usage?.inputTokens,
  outputTokens: res.usage?.outputTokens,
  latencyMs,
});
```
Remove the `final_output` line from `failStalePending`; adjust its int test that expected `final_output` copied from the attempt (expect `null`).
- [ ] Step 4: Re-run both int specs -> PASS.

### Task 3: household_id and household-scoped S3 keys

**Files:**
- Modify: `src/modules/storage/storage.service.ts` (`put(buffer, mediaType, householdId?)`, interface line 17)
- Modify: `src/modules/ai-gateway/ai-gateway.service.ts` (`run` opts `{ userId?: string; householdId?: string }`, pass to `logger.begin` and `storage.put`)
- Modify: `src/modules/ai-gateway/internal/ai-request-logger.ts` (`BeginArgs.householdId?`, `household: em.getReference(Household, id)`)
- Modify: `src/modules/bill/bill-ai.orchestrator.ts`, `src/modules/bill/bill-photo.service.ts` (pass `householdId`)
- Test: `src/modules/storage/storage.service.spec.ts`, gateway int-spec, orchestrator/photo specs if they assert call args

- [ ] Step 1: Storage spec:
```ts
it('puts the image under the household prefix', async () => {
  const { key } = await service.put(buf, 'image/jpeg', 'hh-1');
  expect(key).toBe(`ai/images/hh-1/${sha256(buf)}.jpg`);
});
it('keeps the flat key without a household', async () => {
  const { key } = await service.put(buf, 'image/jpeg');
  expect(key).toBe(`ai/images/${sha256(buf)}.jpg`);
});
```
Gateway int-spec: run with `{ userId, householdId }` -> `ai_requests.household_id === householdId`, `image_s3_keys[0]` starts with `ai/images/${householdId}/`.
- [ ] Step 2: Run -> FAIL.
- [ ] Step 3: Implement:
```ts
const prefix = householdId ? `ai/images/${householdId}` : 'ai/images';
const key = `${prefix}/${hash}.${ext}`;
```
Orchestrator signatures gain `householdId: string` after `userId`; photo service passes its `householdId`.
- [ ] Step 4: Run affected unit + int specs -> PASS; `npm run type-check`.

### Task 4: Retention module

**Files:**
- Create: `src/modules/retention/retention.env.ts`, `retention.env.spec.ts`, `retention-lock.ts`, `retention.service.ts`, `retention.service.int-spec.ts`, `retention.module.ts`
- Modify: `src/app.module.ts` (import `RetentionModule`), `.env.example`

**Produces:**
```ts
export interface RetentionConfig { refreshTokenDays: number; sessionDays: number; aiAuditRawDays: number }
export const RETENTION_CONFIG: unique symbol;
export function readRetentionConfig(): RetentionConfig;
export async function runExclusive<T>(em: EntityManager, name: string, fn: (tx: EntityManager) => Promise<T>): Promise<{ ran: true; result: T } | { ran: false }>;
class RetentionService { purgeRefreshTokens(now?: Date): Promise<number>; purgeSessions(now?: Date): Promise<number>; scrubAiAudit(now?: Date): Promise<number>; runScheduled(): Promise<void> }
```

- [ ] Step 1: env spec — defaults 7/30/30; `"0"`, `"1.5"`, `"abc"` throw with the variable name; `"14"` -> 14.
- [ ] Step 2: int-spec (PostgreSQL, same bootstrap as `src/modules/bill/draft-cleanup.int-spec.ts`), `now = new Date('2030-01-01T00:00:00Z')`, service built with batch size 2:
  - refresh tokens: `expires_at = now-8d` deleted; `now-6d` and future kept.
  - sessions: `absolute_expires_at = now-31d` deleted (its refresh tokens gone by cascade); `absolute_expires_at = now-29d` kept; `is_active=false, last_activity_at=now-31d, absolute_expires_at=future` deleted; `is_active=true, last_activity_at=now-31d, absolute_expires_at=future` kept.
  - AI: SUCCESS request `created_at=now-31d` with attempt raw/parsed -> all four fields null, `total_cost_usd`/`status` intact; `created_at=now-29d` untouched; PENDING `now-31d` untouched; 3 old rows processed with batch size 2 (two batches).
  - lock: hold `pg_advisory_xact_lock(hashtext('retention:refresh-tokens'))` in an open transaction on another fork -> `purgeRefreshTokens` returns 0 and the expired row remains.
- [ ] Step 3: Run `npx jest --config test/jest-e2e.json src/modules/retention` -> FAIL.
- [ ] Step 4: Implement `retention-lock.ts`:
```ts
export async function runExclusive<T>(em, name, fn) {
  return em.fork().transactional(async (tx) => {
    const rows = await tx.getConnection().execute<Array<{ locked: boolean }>>(
      'select pg_try_advisory_xact_lock(hashtext(?)) as locked',
      [`retention:${name}`], 'all', tx.getTransactionContext());
    if (!rows[0]?.locked) return { ran: false } as const;
    return { ran: true, result: await fn(tx) } as const;
  });
}
```
Service: private `runBatches(name, sql, params)` loops `runExclusive` per batch (`execute(sql, [...params, batchSize], 'run', ctx).affectedRows`) until `!ran` or `affected < batchSize`; returns total. SQL:
```sql
-- refresh-tokens
delete from refresh_tokens where id in (select id from refresh_tokens where expires_at < ? limit ?)
-- sessions
delete from sessions where id in (select id from sessions
  where absolute_expires_at < ? or (is_active = false and coalesce(last_activity_at, created_at) < ?) limit ?)
-- ai-audit
with batch as (select id from ai_requests
   where prompt is not null and created_at < ? and status <> 'PENDING' order by created_at limit ?),
 att as (update ai_request_attempts set raw_response_text = null, parsed_json = null
   where ai_request_id in (select id from batch))
update ai_requests set prompt = null, final_output = null, updated_at = now()
 where id in (select id from batch)
```
`@Cron('0 4 * * *', { name: 'data-retention', timeZone: 'UTC' })` runs the three in sequence, each in its own try/catch, logging counts > 0 (pattern of `DraftCleanupService.runScheduled`). Batch size: constructor-injected `RETENTION_BATCH_SIZE` token, default 5000.
- [ ] Step 5: Module providers: `RetentionService`, `{ provide: RETENTION_CONFIG, useFactory: readRetentionConfig }`, `{ provide: RETENTION_BATCH_SIZE, useValue: 5000 }`; import into `AppModule`; add three vars to `.env.example` with comments.
- [ ] Step 6: Run unit + int specs -> PASS.

### Task 5: README

**Files:** Modify `README.md` (new `## Data Retention` section + TOC entry; env vars under Environment Variables).

- [ ] Content: policy table (table / rule / env / default), note that `logs` and AI metadata are kept indefinitely, single-instance guarantee via advisory lock, image key layout, S3 lifecycle example:
```bash
mc ilm rule add --prefix "ai/images/" --expire-days 30 local/receipts
```
and AWS JSON `{"Rules":[{"ID":"expire-ai-images","Filter":{"Prefix":"ai/images/"},"Status":"Enabled","Expiration":{"Days":30}}]}`.

### Final verification
`npm run lint:check && npm run type-check && npm test && npm run build && npm run test:e2e`, migration up/down/up, then code review, then one commit.
