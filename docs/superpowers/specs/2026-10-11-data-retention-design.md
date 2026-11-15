# P33 · Data retention — design

## Goal
Bound the growth of auth and AI-audit tables, keep receipt OCR only as long as it
is useful for debugging, and make S3 receipt images attributable to a household.

## Decisions (agreed with user)
- `logs` are NOT purged.
- AI audit rows are kept forever; only raw payload fields are nulled after
  `AI_AUDIT_RAW_RETENTION_DAYS` (default 30).
- Auth: `refresh_tokens` deleted 7 days after `expires_at`
  (`REFRESH_TOKEN_RETENTION_DAYS`); `sessions` deleted 30 days after expiry or,
  when inactive, 30 days after last activity (`SESSION_RETENTION_DAYS`).
- Stale PENDING AI rows: already handled by `AiAuditSweeper` (P09) — untouched.
- S3 lifecycle rule (30 days on `ai/images/`) is documented only, not applied in code.

## Components
- `src/modules/retention/`
  - `retention.env.ts` — reads/validates the three day counts (integer >= 1).
  - `retention-lock.ts` — `runExclusive(em, name, fn)`: transaction +
    `pg_try_advisory_xact_lock(hashtext('retention:' || name))`; returns
    `{ ran: false }` when another instance holds it.
  - `retention.service.ts` — `@Cron` daily 04:00 UTC; methods
    `purgeRefreshTokens(now)`, `purgeSessions(now)`, `scrubAiAudit(now)`,
    each batched (5000 rows per statement, loop until fewer than batch).
  - `retention.module.ts`, registered in `AppModule`.
- Session purge condition:
  `absolute_expires_at < now - N` OR
  (`is_active = false` AND `coalesce(last_activity_at, created_at) < now - N`).
  Refresh tokens cascade.
- AI scrub: `ai_requests.prompt`, `final_output` -> NULL and
  `ai_request_attempts.raw_response_text`, `parsed_json` -> NULL for requests
  with `created_at < now - N AND prompt IS NOT NULL`.

## Dedupe OCR
- Successful attempt: `raw_response_text`, `parsed_json` not stored; result lives
  only in `ai_requests.final_output`. Failed attempts keep both for diagnostics.
- Stale PENDING sweeper no longer derives `final_output` from the winning
  attempt's `parsed_json` (it is not stored).

## Household
- `ai_requests.household_id uuid NULL` FK -> households ON DELETE SET NULL, indexed.
- `AiGatewayService.run(task, input, { userId, householdId })` -> `logger.begin`.
- Bill AI orchestrator passes `householdId`.
- `StorageService.put(buffer, mediaType, householdId?)` key:
  `ai/images/{householdId}/{sha256}.{ext}`; without household the legacy flat key.
  Existing objects are not migrated.

## Migration
- `ai_requests.prompt` DROP NOT NULL; add `household_id` + FK + index.
- Indexes: `refresh_tokens(expires_at)`, `sessions(absolute_expires_at)`,
  partial `ai_requests(created_at) WHERE prompt IS NOT NULL`.
- Down reverses (prompt NOT NULL restored after filling NULLs with `{"messages":[]}`).

## Testing
- int-spec on PostgreSQL with fake dates for each job and lock contention.
- unit: env parsing, storage key, successful attempt does not persist duplicates.

## Docs
- README "Data retention" section: policy table, env vars, S3 lifecycle example.
