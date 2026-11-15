# Batch Bill Photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload 1–20 receipt photos in one request, parse them in the background through a BullMQ queue, report each result over SSE, and keep photos that cannot become drafts as `failed` bills with an error.

**Architecture:** `parse-photos` prepares and stores the images, saves a `bill_batches` row with one `bill_batch_items` row per photo and enqueues one BullMQ job per item. `BillPhotoProcessor` (in the API process) runs the shared `BillPhotoIngestService` — the body of today's `parsePhoto` — and publishes item events to Redis pub/sub; `BillEventsHub` fans them out to `@Sse()` streams per household.

**Tech Stack:** NestJS 11, MikroORM 7 (PostgreSQL), BullMQ + `@nestjs/bullmq`, ioredis, RxJS, Jest (unit `*.spec.ts`, e2e `test/*.e2e-spec.ts`).

**Spec:** `docs/superpowers/specs/2026-11-02-batch-bill-photos-design.md`

## Global Constraints

- `docs/` is gitignored: plan, spec and doc edits stay local; commit only `src/`, `test/`, `package*.json`.
- Work on branch `feat/batch-bill-photos` from `dev`; commit messages follow `type(scope): summary` (see `git log`).
- Batch size 1–20; each file ≤ `MAX_UPLOAD_BYTES` (10 MB); multer limits `files: 20, fields: 0`.
- Error codes exactly: `not_a_receipt`, `ai_failed`, `save_failed`.
- Messages exactly: `not_a_receipt` → "The photo is not a receipt or no items were recognized on it"; `save_failed` → "The bill was recognized but the draft could not be saved; enter it manually"; `ai_failed` → "Daily AI budget reached; retry tomorrow" (budget), "The AI service is unavailable; retry later" (`AiGatewayExhaustedError`), "Processing failed; retry later" (anything else), "The photo could not be queued; retry later" (enqueue failure).
- Env: `BILL_BATCH_ENABLED` (default `true`), `BILL_BATCH_CONCURRENCY` (default 2, min 1), `BILL_BATCH_ATTEMPTS` (default 3, min 1). Read with `readInt` from `src/modules/ai-gateway/internal/ai-call-config.ts`.
- Queue name `bill-photo`; job payload `{ itemId: string }`; `jobId = itemId`; backoff exponential 5000 ms; `removeOnComplete`/`removeOnFail: { age: 86400 }`.
- Redis channel `bill-events:{householdId}`; SSE heartbeat 25 s; headers `Cache-Control: no-cache`, `X-Accel-Buffering: no`.
- `parse-photo` responses and status codes must not change.
- Every PR-sized step passes `npm run lint:check`, `npm run type-check`, `npm test`.

## Review Focus

1. **The same photo twice in one batch** — two items with the same hash: the first makes a draft, the second must end `done` pointing at that draft (unique index race in `createDraftFromParsed` returns `duplicate: true`), not `failed`. Test in Task 7.
2. **A job re-run after its item finished** (stalled check, manual re-add) — must not create a second bill or send a second `batch.completed`. Test in Task 7.
3. **Worker crash between creating the failed bill and marking the item** — both happen in one transaction; a re-run sees the item `failed` and returns. Test in Task 6 (`markItemFailed` is transactional and idempotent).
4. **SSE client from another household** subscribing to a `hid` it is not a member of — `HouseholdMemberGuard` rejects with 403/404 before the stream opens; hub never emits other households' events. Test in Task 9 e2e.
5. **Failed bill deleted while a retry is running** — retry soft-deletes the old failed bill up front, so a later delete of it is 404 and the new item is unaffected. Test in Task 6.

---

### Task 1: Schema — failed status, batch tables, bill columns

**Files:**
- Create: `src/migrations/Migration20261102120000_AddFailedBillStatus.ts` (enum value only, alone — see `Migration20261101120000_AddDuplicateBillStatus.ts`)
- Create: `src/migrations/Migration20261102120001_AddBillBatches.ts`
- Create: `src/types/bill-parse-error.enum.ts`, `src/types/bill-batch-item-status.enum.ts`
- Create: `src/entities/bill-batch.entity.ts`, `src/entities/bill-batch-item.entity.ts`
- Modify: `src/types/bill-status.enum.ts`, `src/entities/bill.entity.ts` (entities are discovered by the `*.entity.ts` glob)
- Test: `test/db-indexes.int-spec.ts`

**Interfaces:**
- Produces:
  - `BillStatus.FAILED = 'failed'`
  - `enum BillParseErrorCode { NOT_A_RECEIPT = 'not_a_receipt', AI_FAILED = 'ai_failed', SAVE_FAILED = 'save_failed' }` (native `bill_parse_error_enum`)
  - `enum BillBatchItemStatus { QUEUED = 'queued', PROCESSING = 'processing', DONE = 'done', FAILED = 'failed' }` (native `bill_batch_item_status_enum`)
  - `Bill.parse_error_code?: BillParseErrorCode | null`, `Bill.parse_error_message?: string | null`, `Bill.image_key?: string | null`
  - `BillBatch { id, household: Household, created_by?: User, total: number, created_at: Date, items: Collection<BillBatchItem> }` table `bill_batches`
  - `BillBatchItem { id, batch: BillBatch, position: number, image_key: string, image_sha256: string, status: BillBatchItemStatus, bill?: Bill | null, updated_at: Date }` table `bill_batch_items`, unique `(batch_id, position)`, `bill_id` FK `set null`, `batch_id` FK `cascade`
  - Check `bills_parse_error_check`: `(status::text = 'failed') = (parse_error_code is not null)`

- [ ] **Step 1: Write the failing test** — in `test/db-indexes.int-spec.ts` add `it('bills_parse_error_check ties failed status to an error code')`: inserting a bill with `status = 'failed'` and null `parse_error_code` rejects with constraint `bills_parse_error_check`; `status = 'draft'` with `parse_error_code = 'ai_failed'` rejects; `status = 'failed'` with `'ai_failed'` succeeds. Add `it('bill_batch_items is unique per batch and position')`.
- [ ] **Step 2: Run** `npm run test:e2e -- db-indexes` — Expected: FAIL (`invalid input value for enum bill_status_enum: "failed"`).
- [ ] **Step 3: Implement** the enums, entities, Bill columns/check decorator (mirror `bills_duplicate_of_check`) and the two migrations (hand-written SQL like the duplicate migrations; `down()` drops tables/columns/check/enums except the enum value).
- [ ] **Step 4: Run** `npm run test:e2e -- db-indexes` and `npm run migration:check` — Expected: PASS, "no pending changes".
- [ ] **Step 5: Commit** `feat(bill): add failed bills and batch tables`

### Task 2: Storage `get`

**Files:**
- Modify: `src/modules/storage/storage.service.ts`
- Test: `src/modules/storage/storage.service.spec.ts`

**Interfaces:**
- Produces: `StorageService.get(key: string): Promise<{ buffer: Buffer; mediaType: ImageMediaType }>`; throws `Error('Stored image not found: <key>')` on a not-found error (reuse `isNotFoundError`); `mediaType` from the object's `ContentType`, falling back to the key's extension via `EXTENSION_MAP`.

- [ ] **Step 1: Write the failing test** — `it('get returns the body and content type')` with the mocked S3 client returning `Body.transformToByteArray()` and `ContentType: 'image/jpeg'`; `it('get throws for a missing key')` with a `NotFound` error.
- [ ] **Step 2: Run** `npm test -- storage.service` — Expected: FAIL (`storage.get is not a function`).
- [ ] **Step 3: Implement** with `GetObjectCommand` and `Body.transformToByteArray()`.
- [ ] **Step 4: Run** `npm test -- storage.service` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(storage): read stored images back`

### Task 3: Failed bills in `BillCrudService`

**Files:**
- Modify: `src/modules/bill/bill-crud.service.ts`, `src/modules/bill/dto/list-drafts-query.dto.ts`, `src/modules/bill/dto/bill-detail-response.dto.ts`, `src/modules/bill/draft-cleanup.service.ts`
- Test: `src/modules/bill/bill-draft-from-ai.int-spec.ts` (createFailedBill, image key), `bill-queries.int-spec.ts` (listDrafts), `bill-confirm.int-spec.ts` (confirm), `draft-cleanup.int-spec.ts`

**Interfaces:**
- Consumes: Task 1 enums/columns.
- Produces:
  - `DraftSource` gains `imageKey?: string` → stored in `bill.image_key`.
  - `createFailedBill(em: EntityManager, args: { householdId: string; userId: string | null; imageKey: string; imageSha256: string; code: BillParseErrorCode; message: string; aiRequestId?: string | null }): Bill` — persists (no flush) a bill with `status FAILED`, `amount 0`, `bill_date = todayIsoDate()`, `bill_date_inferred true`; `image_sha256` set. Takes the caller's `em` so Task 6 can wrap it in a transaction.
  - `getDraftImageKey(id, householdId)` accepts `DRAFT` or `FAILED`, returns `bill.image_key ?? bill.ai_request?.image_s3_keys?.[0]`.
  - `ListDraftsQueryDto.status?: 'draft' | 'failed'` (`@IsIn`, default `'draft'`); `listDrafts` filters by it.
  - `BillDetailResponseDto` gains `parse_error_code: BillParseErrorCode | null` and `parse_error_message: string | null`.
  - `confirmBill` accepts `DRAFT` or `FAILED`; on confirm sets `parse_error_code = null`, `parse_error_message = null` in the same flush (the check constraint requires both cleared before status leaves `failed`).
  - `DraftCleanupService.purgeStaleDrafts` filters `status: { $in: [DRAFT, FAILED] }`.

- [ ] **Step 1: Write the failing tests** — `createFailedBill` stores amount 0, inferred date, code and message; `listDrafts({ status: 'failed' })` returns only failed bills and `listDrafts({})` only drafts; `confirmBill` on a failed bill returns `status: 'confirmed'`, `parse_error_code: null`; `getDraftImageKey` on a failed bill without an AI request returns its `image_key`; cleanup purges a stale failed bill.
- [ ] **Step 2: Run** `npm run test:e2e -- bill-draft-from-ai bill-queries bill-confirm draft-cleanup` — Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** `npm run test:e2e -- bill-draft-from-ai bill-queries bill-confirm draft-cleanup` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(bill): list, confirm and clean up failed bills`

### Task 4: Extract `BillPhotoIngestService`

**Files:**
- Create: `src/modules/bill/bill-photo-ingest.service.ts`, `src/modules/bill/bill-photo-ingest.service.spec.ts`
- Modify: `src/modules/bill/bill.controller.ts` (`parsePhoto`), `src/modules/bill/bill.controller.spec.ts`, `src/modules/bill/bill.module.ts`

**Interfaces:**
- Consumes: `BillPhotoService.parseAndCategorize`, `BillCrudService.findDraftByImageHash`, `createDraftFromParsed` (with `imageKey` from Task 3).
- Produces:
  ```ts
  export interface IngestInput {
    image: Buffer; mediaType: ImageMediaType; imageSha256: string;
    imageKey?: string; householdId: string; userId: string;
  }
  export type IngestResult =
    | { kind: 'existing'; billId: string }
    | { kind: 'draft'; billId: string; duplicate: boolean; requestId: string }
    | { kind: 'not_a_receipt'; requestId: string }
    | { kind: 'save_failed'; requestId: string; parsed: ParsedBillResponseDto };
  ingest(input: IngestInput): Promise<IngestResult>
  ```
  AI errors propagate unchanged. The controller keeps `duplicateResponse`, `possibleDuplicates` and the response shaping, and maps `not_a_receipt` / `save_failed` to today's 422 bodies.

- [ ] **Step 1: Move tests** — the `bill.controller.spec.ts` cases that assert ingest decisions (same-hash short-circuit, not-a-receipt, save failure keeps `parsed`) get an `ingest` counterpart in `bill-photo-ingest.service.spec.ts`; the controller spec keeps every response/status assertion, now with `BillPhotoIngestService` provided for real over the same mocks.
- [ ] **Step 2: Run** `npm test -- bill-photo-ingest` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the service and slim `parsePhoto` to `prepareReceiptImage` → hash → `ingest` → map.
- [ ] **Step 4: Run** `npm test -- bill` and `npm run test:e2e -- parse-photo` — Expected: PASS, no controller assertion changed.
- [ ] **Step 5: Commit** `refactor(bill): share the photo ingest core`

### Task 5: Per-user AI quota outside the guard

**Files:**
- Create: `src/modules/ai-gateway/ai-user-quota.service.ts`, `src/modules/ai-gateway/ai-user-quota.service.spec.ts`
- Modify: `src/modules/ai-gateway/guards/user-throttler.guard.ts` (export key builder), `src/modules/ai-gateway/ai-gateway.service.ts` (make `assertWithinBudget` public), `src/modules/ai-gateway/ai-gateway.module.ts` (provide + export)

**Interfaces:**
- Produces:
  - `export function userThrottlerKey(name: 'ai-minute' | 'ai-day', userId: string): string` → `user-throttler:${name}:user:${userId}`; the guard's `generateKey` uses it.
  - `AiUserQuota.reserveDaily(userId: string, count: number): Promise<{ allowed: boolean; retryAfterSec: number }>` — `count` increments of the `ai-day` key via the injected `ThrottlerStorage` (`ttl = DAY_MS`, `limit = userPerDay`, `blockDuration = DAY_MS`); `allowed = false` when the last `totalHits > limit`. `count <= 0` → allowed without touching storage.
  - `AiUserQuota.takeMinute(userId: string): Promise<{ allowed: boolean; retryAfterMs: number }>` — one increment of `ai-minute`.
  - `AiGatewayService.assertWithinBudget(userId: string): Promise<void>` (unchanged body, now public).

- [ ] **Step 1: Write the failing tests** — with the in-memory `ThrottlerStorageService` and `userPerDay = 3`: `reserveDaily(u, 3)` allowed, then `reserveDaily(u, 1)` not allowed with `retryAfterSec > 0`; `takeMinute` blocks after `userPerMinute`; a guard-protected request and `reserveDaily` share the counter (call `storage.increment(userThrottlerKey('ai-day', u), …)` once, then `reserveDaily(u, 3)` is refused).
- [ ] **Step 2: Run** `npm test -- ai-user-quota user-throttler` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -- ai-user-quota user-throttler ai-gateway` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): count per-user AI quota outside the HTTP guard`

### Task 6: Queue module, events and `BillBatchService`

**Files:**
- Create: `src/modules/bill/batch/bill-batch.env.ts`, `bill-batch.module.ts`, `bill-batch.service.ts`, `bill-batch.service.int-spec.ts`, `bill-events.publisher.ts`, `bill-events.hub.ts`, `bill-events.hub.spec.ts`, `bill-events.types.ts`, `dto/bill-batch-response.dto.ts`
- Modify: `package.json` (`bullmq`, `@nestjs/bullmq`), `src/modules/bill/bill.module.ts`, `src/app.module.ts`, `test/setup/test-env.ts` (`BILL_BATCH_ENABLED=false`)

**Interfaces:**
- Consumes: Task 1 entities, Task 2 `storage.put`, Task 3 `createFailedBill`, Task 5 `AiUserQuota`, `AiGatewayService.assertWithinBudget`.
- Produces:
  - `readBillBatchEnv(env = process.env): { enabled: boolean; concurrency: number; attempts: number }`.
  - `BillBatchModule.register(): DynamicModule` — when `enabled`, `BullModule.forRoot({ connection: { ...redisConnectionOptions(), maxRetriesPerRequest: null } })`, `BullModule.registerQueue({ name: BILL_PHOTO_QUEUE })`, the publisher, hub and (Task 7) processor; otherwise provides `BILL_BATCH_DISABLED = true` only.
  - `export const BILL_PHOTO_QUEUE = 'bill-photo'`.
  - `bill-events.types.ts`:
    ```ts
    type ItemEvent = { batch_id: string; item_id: string; position: number;
      status: BillBatchItemStatus; created_by_user_id: string | null;
      bill_id?: string; parse_error_code?: BillParseErrorCode; parse_error_message?: string };
    export type BillEvent =
      | { type: 'item.processing' | 'item.done' | 'item.failed'; data: ItemEvent }
      | { type: 'batch.completed'; data: { batch_id: string; total: number; done: number; failed: number; created_by_user_id: string | null } };
    ```
  - `BillEventsPublisher.publish(householdId: string, event: BillEvent): Promise<void>` — `PUBLISH bill-events:{hid} JSON`; logs and swallows errors (events are best effort; state is in the DB).
  - `BillEventsHub.stream(householdId: string): Observable<BillEvent>` — one `PSUBSCRIBE bill-events:*` connection opened on first use, closed in `onModuleDestroy`; per-household `Subject` removed when its last subscriber unsubscribes.
  - `BillBatchService`:
    - `createBatch(args: { householdId: string; userId: string; images: { buffer: Buffer; mediaType: ImageMediaType; sha256: string }[] }): Promise<BillBatchResponseDto>` — `reserveDaily(userId, images.length - 1)` (refused → `ThrottlerException` with the guard's message shape and `retryAfterSec`), `assertWithinBudget`, `storage.put` each, one transaction for batch + items, then `queue.addBulk`; an `addBulk` error → `markItemFailed` for every item with "The photo could not be queued; retry later", then the response.
    - `getBatch(householdId: string, batchId: string): Promise<BillBatchResponseDto>` — 404 outside the household.
    - `retry(householdId: string, userId: string, billId: string): Promise<BillBatchResponseDto>` — failed, non-deleted bill with `image_key` else 409; daily quota (1) and budget checks; one transaction: soft-delete the failed bill, create a one-item batch; then enqueue.
    - `markItemDone(itemId: string, billId: string): Promise<{ changed: boolean }>` and `markItemFailed(itemId: string, args: { code: BillParseErrorCode; message: string; aiRequestId?: string | null; billId?: string }): Promise<{ changed: boolean; billId: string | null }>` — transactional, lock the item row, return `changed: false` when it is already `done`/`failed`; `markItemFailed` creates the failed bill via `createFailedBill` unless `billId` is given.
    - `markItemProcessing(itemId: string)` / `markItemQueued(itemId: string)`.
    - `completionOf(batchId: string): Promise<{ total; done; failed } | null>` — `null` while any item is `queued`/`processing`.
  - `BillBatchResponseDto` exactly as in spec section 2 (`batch_id, created_at, total, completed, items[{ id, position, status, bill_id, parse_error_code, parse_error_message }]`).

- [ ] **Step 1: Install** `npm i bullmq @nestjs/bullmq` — Expected: added to `dependencies`.
- [ ] **Step 2: Write the failing tests** — `bill-batch.service.int-spec.ts` (real test DB as in `bill-confirm.int-spec.ts`; `Queue`, storage and `AiUserQuota` mocked): `createBatch` stores 3 items `queued` in order and calls `addBulk` with `jobId = item.id`; refused `reserveDaily` → `ThrottlerException`, nothing stored; `addBulk` throws → all items `failed` with the queued message and failed bills; `markItemFailed` twice → second `changed: false`, one bill; `retry` of a non-failed bill → 409; `retry` soft-deletes the old bill and a later `softDeleteBill` of it → 404 (Review Focus 5). `bill-events.hub.spec.ts` with a fake subscriber: events reach only the matching household; last unsubscribe drops the Subject.
- [ ] **Step 3: Run** `npm run test:e2e -- bill-batch.service` and `npm test -- bill-events` — Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `npm test -- bill-events` and `npm run test:e2e` (whole suite: proves `BILL_BATCH_ENABLED=false` leaves other specs untouched) — Expected: PASS.
- [ ] **Step 6: Commit** `feat(bill): store and queue photo batches`

### Task 7: `BillPhotoProcessor`

**Files:**
- Create: `src/modules/bill/batch/bill-photo.processor.ts`, `bill-photo.processor.spec.ts`
- Modify: `src/modules/bill/batch/bill-batch.module.ts`

**Interfaces:**
- Consumes: Task 4 `ingest`, Task 5 `takeMinute`, Task 6 `BillBatchService.mark*`, `completionOf`, `BillEventsPublisher.publish`, Task 2 `storage.get`.
- Produces: `@Processor(BILL_PHOTO_QUEUE, { concurrency })` `BillPhotoProcessor extends WorkerHost` with `process(job: Job<{ itemId: string }>, token?: string): Promise<void>` and `@OnWorkerEvent('failed') onFailed(job, err)`.

Flow per spec section 3. Error mapping:
- `takeMinute` not allowed → `markItemQueued`, `await job.moveToDelayed(Date.now() + retryAfterMs, token)`, `throw new DelayedError()`.
- `AiCapacityExceededError` → same, delay `retryAfterSec * 1000`.
- `AiBudgetExceededError` → `throw new UnrecoverableError(...)`.
- other errors → rethrow.
- `onFailed`: final when `err instanceof UnrecoverableError || job.attemptsMade >= attempts`; then `markItemFailed(ai_failed, message by cause)`, publish `item.failed`, then `batch.completed` if `completionOf` is non-null and the mark `changed`.
- `batch.completed` is published only by the call whose `mark*` returned `changed: true` and found the batch complete.

- [ ] **Step 1: Write the failing tests** — one per row: draft → `item.done` with `bill_id`; `existing` → `done` pointing at the existing draft; second item with the same hash whose `createDraftFromParsed` races → `done`, `duplicate` (Review Focus 1); `not_a_receipt` → failed bill + `item.failed`; `save_failed` → `save_failed`; minute limit → `moveToDelayed` + `DelayedError`, item back to `queued`; capacity → delayed by `retryAfterSec`; budget → `UnrecoverableError`, `onFailed` makes `ai_failed` "Daily AI budget reached; retry tomorrow"; `AiGatewayExhaustedError` on the last attempt → "The AI service is unavailable; retry later"; not the last attempt → no failed bill; a job for a `done` item returns without calling `ingest` and publishes nothing (Review Focus 2); last item of a batch → exactly one `batch.completed`.
- [ ] **Step 2: Run** `npm test -- bill-photo.processor` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -- bill-photo.processor` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(bill): parse queued photos in a worker`

### Task 8: Endpoints

**Files:**
- Create: `src/modules/bill/batch/bill-batch.controller.ts`, `bill-batch.controller.spec.ts`
- Modify: `src/modules/bill/dto/api-responses.decorator.ts`, `src/modules/bill/bill.controller.ts` (only if `retry` lives on the bills path there — prefer the new controller with explicit paths)

**Interfaces:**
- Consumes: Task 6 `BillBatchService`, `BillEventsHub`, `BILL_BATCH_DISABLED`.
- Produces (all under `JwtAuthGuard, HouseholdMemberGuard`, `@ApiTags('bills')`):
  - `POST households/:hid/bills/parse-photos` — `@UseGuards(UserThrottlerGuard)`, `FilesInterceptor('images', 20, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 20, fields: 0 } })`, the three AI filters, `@HttpCode(202)`. Zero files → 400. `prepareReceiptImage` per file in order; a failure → 400 `"File <index>: <original message>"` (keep 415 for an unsupported type when that is what `prepareReceiptImage` throws, with the index prefixed).
  - `GET households/:hid/bill-batches/:id` (`ParseUUIDPipe`).
  - `POST households/:hid/bills/:id/retry` — `UserThrottlerGuard`, AI filters, 202.
  - `@Sse() GET households/:hid/bills/events` → `Observable<MessageEvent>`: `hub.stream(hid)` mapped to `{ type, data, id: randomUUID() }`, merged with `interval(25_000)` heartbeats, `takeUntil(timer(msUntil(user token exp)))`; sets `Cache-Control` and `X-Accel-Buffering` on the response. Heartbeat: Nest's `@Sse` cannot send comment lines, so send `{ type: 'ping', data: '' }`; document it as an event the client ignores.
  - Any of these with `BILL_BATCH_DISABLED` → 503 "Batch photo parsing is disabled".
  - Swagger decorators `ApiParsePhotosResponses`, `ApiBillBatchResponses`, `ApiRetryBillResponses`, `ApiBillEventsResponses`.

- [ ] **Step 1: Write the failing tests** — controller spec: 21 files rejected by multer config (assert interceptor options); file 1 of 2 invalid → 400 with `File 1:`; zero files → 400; stream completes at the token's `exp` (fake timers); disabled → 503.
- [ ] **Step 2: Run** `npm test -- bill-batch.controller` — Expected: FAIL.
- [ ] **Step 3: Implement.** `AuthenticatedUser` has no `exp` today: add `exp: number` to the type in `src/modules/auth/types/jwt-payload.interface.ts` and set it from `payload.exp` in the JWT strategy's `validate()`; the stream ends at `exp * 1000`.
- [ ] **Step 4: Run** `npm test -- bill-batch.controller` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(bill): batch upload, status, retry and event endpoints`

### Task 9: End-to-end and docs

**Files:**
- Create: `test/bill-batch.e2e-spec.ts`
- Modify (local only, gitignored): `docs/environment-variables.md`, `docs/deployment-linux-server.md`; Create: `docs/frontend-batch-parse-integration.md`

**Interfaces:**
- Consumes: everything above. Sets `process.env.BILL_BATCH_ENABLED = 'true'` before `createTestApp`; overrides `STORAGE_SERVICE` with an in-memory map store and `BillPhotoService.parseAndCategorize` with a mock (as `parse-photo-upload.e2e-spec.ts` does); uses the compose Redis (`REDIS_HOST/PORT`) and obliterates the `bill-photo` queue in `beforeAll`.

- [ ] **Step 1: Write the tests:**
  - 3 photos, the 2nd mocked as not a receipt → 202 with 3 `queued` items; the SSE stream (read with `supertest` `.buffer(false)` + parser, or `fetch` against `app.listen(0)`) yields `item.processing`/`item.done` for positions 0 and 2, `item.failed` with `not_a_receipt` for 1, then `batch.completed { done: 2, failed: 1 }`; `GET bill-batches/:id` has `completed: true` and matching items; `GET bills/drafts?status=failed` lists one bill with the message.
  - The failed bill: `PUT` items then `confirm` → `confirmed`; a second failed bill `retry` → 202 and its new item ends `done`.
  - `AI_USER_LIMIT_PER_DAY` smaller than the batch (re-create app with the env lowered) → 429, nothing queued.
  - One text file among 2 → 400, no batch row.
  - A member of another household: `GET bill-batches/:id` → 404 (or 403 from the guard, assert the existing household-isolation status); `GET households/<other>/bills/events` → same (Review Focus 4).
- [ ] **Step 2: Run** `docker compose up -d redis` then `npm run test:e2e -- bill-batch` — Expected: PASS.
- [ ] **Step 3: Write docs** — env vars (`BILL_BATCH_ENABLED`, `BILL_BATCH_CONCURRENCY`, `BILL_BATCH_ATTEMPTS`); nginx `location ~ /bills/events$ { proxy_buffering off; proxy_read_timeout 1h; proxy_http_version 1.1; proxy_set_header Connection ""; … }`; frontend guide: upload, `fetch-event-source` with Bearer, ignore `ping`, reconnect on close → refetch open batches, failed group with Retry / Enter manually (PUT + confirm) / Delete.
- [ ] **Step 4: Verify** `npm run lint:check && npm run type-check && npm test && npm run test:e2e` — Expected: all PASS.
- [ ] **Step 5: Commit** `test(bill): cover batch photo parsing end to end`
