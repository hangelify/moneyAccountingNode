# Batch bill photos — design

Date: 2026-11-02
Status: approved design, not implemented

## Goal

`POST /households/:hid/bills/parse-photo` parses one receipt per request and
blocks until the AI answers. A user who comes home with a week of receipts
has to upload them one by one and wait for each.

After this change the user uploads **2–20 photos in one request**, gets an
answer at once, and the API parses them **in the background**. The client
learns about each photo as it finishes through **Server-Sent Events**. A photo
that cannot become a draft becomes a bill with status **`failed`**, carrying
the error, so the frontend can show it in its own group with the reason and
let the user retry, enter it by hand or delete it.

### Decisions taken

- **Queue: BullMQ** on the existing Redis. It brings retries with backoff,
  stalled-job recovery, delayed jobs and a concurrency cap. Rejected:
  hand-rolled Redis Streams (all of that to write and test ourselves) and a
  Postgres `SKIP LOCKED` queue (polling worker, and Redis is already there).
- **Worker runs in the API process.** Production runs PM2 with
  `instances: 1`; the worker is a Nest provider that can move to its own
  process later without code changes.
- **Events go through Redis pub/sub**, not an in-memory emitter, so they
  still reach the client once the worker or the API runs as more than one
  process.
- **SSE is live only.** No notification inbox, no replay. After a reconnect
  the client refetches the batch; batch items and bills hold the full state.
- **A failed photo is a bill** (`status = 'failed'`), so the existing edit,
  confirm and delete endpoints work on it and the frontend lists it next to
  drafts.
- **`parse-photo` is unchanged** for clients. Its body moves into a service
  shared with the worker.
- Batch size 1–20, uploaded through the API as multipart. Direct presigned
  uploads are not needed at this size.
- **Out of scope:** notification inbox, per-user unread state, replay with
  `Last-Event-ID`, a separate worker deployment.

## 1. Data model

### New table `bill_batches`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `household_id` | uuid | FK households, not null |
| `created_by_user_id` | uuid | FK users, `set null` on delete |
| `total` | integer | number of photos, 1–20 |
| `created_at` | timestamptz | default now() |

### New table `bill_batch_items`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK; also the BullMQ `jobId` |
| `batch_id` | uuid | FK bill_batches, `cascade` on delete |
| `position` | integer | 0-based order in the upload; unique per batch |
| `image_key` | varchar | S3 key, `ai/images/{householdId}/{sha256}.jpg` |
| `image_sha256` | varchar(64) | hash of the prepared image |
| `status` | enum `bill_batch_item_status_enum` | `queued`, `processing`, `done`, `failed` |
| `bill_id` | uuid | FK bills, nullable, `set null` on delete; set on `done` and `failed` |
| `updated_at` | timestamptz | |

Index: `(batch_id, position)` unique.

### `bills`

- `BillStatus.FAILED = 'failed'` added to `bill_status_enum`.
- New nullable columns:
  - `parse_error_code` enum `bill_parse_error_enum`: `not_a_receipt`,
    `ai_failed`, `save_failed`.
  - `parse_error_message` text: a human-readable reason for the frontend.
  - `image_key` varchar: set on every bill created from a batch (draft or
    failed). Draft images today come from `ai_request.image_s3_keys`; a
    failed bill may have no AI request, so the key is stored on the bill.
    The draft-image endpoint reads `image_key` first, then falls back to the
    AI request.
- Check `bills_parse_error_check`:
  `(status::text = 'failed') = (parse_error_code is not null)`.
- A failed bill has `amount = 0`, `bill_date` = upload day,
  `bill_date_inferred = true`, no items, no market.
- The unique draft index on `image_sha256` is unchanged: it only covers
  `status = 'draft'`, so a failed bill never blocks a later upload of the
  same photo.

### Where failed bills appear

- Every money aggregate (dashboard, spending breakdown, budgets) already
  filters `status = 'confirmed'`, so failed bills are not counted.
- `GET .../bills/drafts` gains `?status=draft|failed` (default `draft`), so
  the frontend can list the failed group.
- `PUT .../bills/:id` (items + market) and confirm accept a failed bill. On
  confirm, `parse_error_code` and `parse_error_message` are cleared together
  with the status change.
- Delete works as for any bill (soft delete).
- `DraftCleanupService` also removes stale failed bills, with the same age
  rule as drafts.

## 2. API

| Method & path | Result |
|---|---|
| `POST /households/:hid/bills/parse-photos` | 202 `BillBatchResponseDto` |
| `GET /households/:hid/bill-batches/:id` | 200 `BillBatchResponseDto` |
| `GET /households/:hid/bills/events` | `text/event-stream` (section 4) |
| `POST /households/:hid/bills/:id/retry` | 202 `BillBatchResponseDto` |

All are behind `JwtAuthGuard` and `HouseholdMemberGuard`. `parse-photos` and
`retry` also use `UserThrottlerGuard` and the AI error filters used by
`parse-photo`.

```jsonc
// BillBatchResponseDto
{
  "batch_id": "uuid",
  "created_at": "2026-11-02T10:00:00Z",
  "total": 3,
  "completed": false,          // true when no item is queued or processing
  "items": [
    {
      "id": "uuid",
      "position": 0,
      "status": "done",        // queued | processing | done | failed
      "bill_id": "uuid",       // null while queued/processing
      "parse_error_code": null,
      "parse_error_message": null
    }
  ]
}
```

### `POST parse-photos`

Multipart field `images`, 1–20 files, each ≤ `MAX_UPLOAD_BYTES` (10 MB).
Multer limits: `files: 20`, `fields: 0`, `fileSize: MAX_UPLOAD_BYTES`.

1. Each file goes through `prepareReceiptImage`, one at a time. Any file that
   fails → **400** for the whole request, `message` naming the 0-based index.
   Nothing is stored or queued.
2. Daily quota: the per-user limits are the `UserThrottlerGuard` counters
   (`ai-minute`, `ai-day`), which count one per HTTP request. The guard on
   `parse-photos` counts the first photo; `AiUserQuota.reserveDaily(userId,
   n - 1)` counts the rest against `ai-day`. Over the limit → **429** with
   the guard's message. The daily spend budget is checked up front through
   `AiGatewayService.assertWithinBudget(userId)` → **429**. The worker does
   not count `ai-day` again; it counts `ai-minute` per photo (section 3).
3. Each prepared image → `storage.put(buffer, mediaType, householdId)`.
4. One transaction: insert the batch and its items (`queued`).
5. After commit: `queue.addBulk` with one job per item,
   `jobId = item.id`, payload `{ itemId }`. If adding fails, the items are
   marked `failed` through the same path as a final job failure
   (`ai_failed`, "could not be queued"), so nothing stays `queued` forever.
6. Answer 202 with the batch.

### `GET bill-batches/:id`

404 when the batch is not in the household.

### `POST bills/:id/retry`

Only a `failed`, non-deleted bill with an `image_key`; otherwise 409. Creates a
one-item batch for that image, soft-deletes the failed bill in the same
transaction, enqueues the item and answers 202. The daily-quota pre-check
applies.

## 3. Worker

### Shared ingest core

`BillPhotoIngestService.ingest({ image, mediaType, imageSha256, imageKey,
householdId, userId })` takes the body of today's `parsePhoto`:

1. Open draft with the same hash → `{ kind: 'existing', billId }`.
2. `BillPhotoService.parseAndCategorize`.
3. Not a receipt → `{ kind: 'not_a_receipt', requestId }`.
4. `createDraftFromParsed` (now also storing `image_key`) →
   `{ kind: 'draft', billId, duplicate }`; a save error →
   `{ kind: 'save_failed', requestId, parsed }`.

AI errors (gateway, usage limit) are thrown, not returned. The controller
maps the results to today's responses and status codes; its behaviour does
not change. `parse-photo` does not set `image_key` on its draft (it has none
before the AI call), and keeps reading the image through the AI request.

### `BillPhotoProcessor`

BullMQ `WorkerHost` on queue `bill-photo`, concurrency
`BILL_BATCH_CONCURRENCY` (default 2). Job options: `attempts =
BILL_BATCH_ATTEMPTS` (default 3), exponential backoff from 5 s,
`removeOnComplete` and `removeOnFail` after 1 day.

Per job:

1. Load the item with its batch. Missing or already `done`/`failed` → return
   (idempotent).
2. Mark `processing`; publish `item.processing`.
3. `storage.get(item.image_key)` — new method on `StorageService`.
4. `ingest(...)` with the batch's household and creator.
5. Result:
   - `existing` / `draft` → item `done`, `bill_id` set.
   - `not_a_receipt` → failed bill (`not_a_receipt`, "The photo is not a
     receipt or no items were recognized on it") → item `failed`.
   - `save_failed` → failed bill (`save_failed`, "The bill was recognized but
     the draft could not be saved; enter it manually").
6. Publish `item.done` or `item.failed`; if no item of the batch is still
   `queued`/`processing`, publish `batch.completed`.

### Errors thrown during a job

| Error | Handling |
|---|---|
| Per-minute user limit: `AiUserQuota.takeMinute(userId)` before the AI call says blocked | `job.moveToDelayed(now + retryAfterMs)` + `DelayedError`; does not use an attempt. Item goes back to `queued`. |
| `AiCapacityExceededError` (all AI slots of the process busy) | Same as above, delayed by its `retryAfterSec`. |
| Transient gateway error | Thrown; BullMQ retries with backoff. |
| `AiBudgetExceededError` (daily spend budget) | `UnrecoverableError`; final failure. |
| Anything else | Thrown; BullMQ retries. |

On final failure (`worker.on('failed')` when `attemptsMade >= attempts`, or an
`UnrecoverableError`): create the failed bill with `ai_failed` and a message by
cause ("Daily AI limit reached; retry tomorrow", "The AI service is
unavailable; retry later", or "Processing failed; retry later"), mark the item
`failed`, publish. Stalled jobs (process crash) are picked up again by BullMQ's
stalled check and follow the same path.

Creating the failed bill and updating the item happen in one transaction.

## 4. Events (SSE)

### Channel

Redis pub/sub channel `bill-events:{householdId}`. `BillEventsPublisher`
publishes JSON on a normal ioredis connection. `BillEventsHub` holds **one**
subscriber connection per process (`PSUBSCRIBE bill-events:*`) and fans out
to an RxJS `Subject` per household with at least one listener.

### Events

| `event:` | `data:` |
|---|---|
| `item.processing` | `{ batch_id, item_id, position, status }` |
| `item.done` | `+ bill_id` |
| `item.failed` | `+ bill_id, parse_error_code, parse_error_message` |
| `batch.completed` | `{ batch_id, total, done, failed }` |

Every payload also carries `created_by_user_id`. All household members get
the events; the frontend shows toasts only to the uploader.

### Endpoint

`GET /households/:hid/bills/events`, Nest `@Sse()`:

- Headers: `Cache-Control: no-cache`, `X-Accel-Buffering: no`.
- A `: ping` comment every 25 s.
- The stream **completes when the access token expires** (its `exp`), so a
  member removed from the household stops receiving events. The client
  reconnects with a fresh token.
- Browsers connect with `fetch` streaming (e.g.
  `@microsoft/fetch-event-source`) and the Bearer header; no token in the
  URL.

## 5. Configuration and deployment

- New dependencies: `bullmq`, `@nestjs/bullmq`. BullMQ uses
  `redisConnectionOptions()` with `maxRetriesPerRequest: null`.
- Env: `BILL_BATCH_CONCURRENCY` (default 2), `BILL_BATCH_ATTEMPTS`
  (default 3), documented in `docs/environment-variables.md`.
- `docs/deployment-linux-server.md`: an nginx `location` for
  `~ /bills/events$` with `proxy_buffering off`, `proxy_read_timeout 1h`,
  `proxy_http_version 1.1`.
- `docs/frontend-batch-parse-integration.md`: upload, SSE connection,
  reconnect + refetch, failed group with Retry / Enter manually / Delete.
- `BILL_BATCH_ENABLED` (default `true`). When `false` the queue, worker and
  events hub are not registered and the batch endpoints answer 503. The e2e
  env sets it to `false`; the batch e2e spec turns it on and needs the
  docker compose Redis, like `login-attempt-store.int-spec.ts`.
- Migration: two enums, two tables, three columns, the enum value and the
  check; `migration:check` passes.

## 6. Testing

Unit:

- `BillPhotoIngestService`: the existing `parsePhoto` controller cases move
  here; the controller keeps thin tests proving responses and status codes
  are unchanged.
- `BillPhotoProcessor`: each row of the error table, idempotent re-run of a
  finished item, `batch.completed` sent once.
- `BillEventsHub`: fan-out per household, unsubscribe on last listener, the
  stream completing at token expiry.
- `AiUserQuota`: shares keys with `UserThrottlerGuard`; `reserveDaily` and
  `takeMinute` report blocked at the limit.

E2E (testcontainers Postgres, Redis, MinIO; fake AI provider):

- Upload 3 photos, one not a receipt → 202; SSE yields `processing`/`done`
  ×2, `failed` ×1, then `batch.completed`; 2 drafts and 1 failed bill exist;
  `GET bill-batches/:id` matches.
- A failed bill can be edited and confirmed; a retry produces a draft.
- 21 files → 413/400; one invalid file → 400, nothing stored.
- Daily quota smaller than the batch → 429.
- A member of another household gets 404 on the batch and no events.
