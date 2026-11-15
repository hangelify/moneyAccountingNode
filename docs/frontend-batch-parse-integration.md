# Frontend Integration: Batch Receipt Photo Parsing

`POST /households/{hid}/bills/parse-photos` · `GET /households/{hid}/bills/events`

## Overview

This guide is for frontend developers who build the "scan several receipts at once"
flow. The user picks 1–20 photos. The API stores them, answers **at once** with a
**batch** (`202 Accepted`), and parses the photos in the background. Each photo ends
as either:

- a **draft bill**, reviewed and confirmed exactly like a single parse-photo draft, or
- a **failed bill**: a bill with `status: "failed"`, the stored photo and an error
  code. The user retries it, enters it manually, or deletes it.

Progress arrives as **server-sent events** (SSE). The batch state can always be
read again with `GET bill-batches/{id}`, so the events are a convenience, not the
source of truth.

```
 ┌────────────┐ multipart ┌───────────────────────────┐ 202 + batch (all "queued")
 │ Pick 1–20  │ ────────▶ │ POST .../bills/parse-photos│ ───────────────┐
 │ photos     │           └───────────────────────────┘                │
 └────────────┘                                                        ▼
        ▲                 ┌───────────────────────────┐   item.processing / item.done /
        │ open first      │ GET .../bills/events (SSE)│ ─ item.failed / batch.completed
        └──────────────── └───────────────────────────┘          │
                                                                  ▼
                    ┌───────────────────────┐        ┌──────────────────────────────┐
                    │ Drafts → review,      │        │ Failed → Retry / Enter        │
                    │ confirm (as usual)    │        │ manually (PUT + confirm) /    │
                    └───────────────────────┘        │ Delete                        │
                                                     └──────────────────────────────┘
```

Endpoints used by the flow:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/households/{hid}/bills/parse-photos` | Upload 1–20 photos; returns the batch (`202`) |
| `GET` | `/households/{hid}/bills/events` | SSE stream of the household's batch progress |
| `GET` | `/households/{hid}/bill-batches/{id}` | Current state of one batch and each photo |
| `GET` | `/households/{hid}/bills/drafts?status=failed` | Failed bills, newest first |
| `GET` | `/households/{hid}/bills/drafts` | Open drafts (as for single parse-photo) |
| `POST` | `/households/{hid}/bills/{id}/retry` | Parse a failed bill's photo again (`202`, new batch) |
| `PUT` | `/households/{hid}/bills/{id}` | Edit a draft or failed bill (enter it manually) |
| `POST` | `/households/{hid}/bills/{id}/confirm` | Confirm a draft or failed bill |
| `DELETE` | `/households/{hid}/bills/{id}` | Discard a draft or failed bill |

All paths have no global prefix and need `Authorization: Bearer <access_token>`.
Swagger UI with the live schemas is served at `/api`.

When the server runs with `BILL_BATCH_ENABLED=false`, every batch route answers
`503` with `message: "Batch photo parsing is disabled"`. Hide the multi-photo entry
point for the session and keep the single-photo flow
([frontend-parse-photo-integration.md](frontend-parse-photo-integration.md)).

---

## 1. Upload

### 1.1 Contract

| | |
|---|---|
| Method | `POST` |
| Path | `/households/{hid}/bills/parse-photos` |
| Body | `multipart/form-data`, **1–20** file fields all named **`images`** |
| Success | `202 Accepted` with a `BillBatch` |

- No other form fields (`fields: 0`); an extra field gives `400`.
- Per file: the same rules as single parse-photo — JPEG, PNG or WebP, at most 10 MB,
  at most 100 megapixels. HEIC is rejected. Resize on the client first (see
  section 1.3 of the parse-photo guide); 20 full-size phone photos are a lot of
  upload.
- **The same photo twice in one upload** is allowed and still gets one item per
  position (map results by `position`). Only the first copy is sent to the AI; each
  later copy waits about 30 s, then finishes `done` with the **same `bill_id`** as
  the first (or is parsed on its own if the first copy failed). Expect those items
  to stay `queued` a little longer. Every copy still counts against the daily quota.
- **The whole request is all or nothing.** If any file is invalid nothing is stored
  or queued and the `message` names the file by its **0-based index** in the order
  you appended them, e.g. `"File 1: The image could not be decoded"`.

### 1.2 Calling it

```ts
export async function uploadBatch(hid: string, files: File[]): Promise<BillBatch> {
  const form = new FormData();
  for (const file of files) form.append('images', file); // order = position
  const { data } = await api.post<BillBatch>(
    `/households/${hid}/bills/parse-photos`,
    form,
  );
  return data; // 202: every item "queued"
}
```

Open the event stream **before** uploading (section 2), or at least before the
response arrives, so no event is missed. If it was not open, read the batch with
`GET bill-batches/{id}` once it is.

### 1.3 Types

```ts
export type BatchItemStatus = 'queued' | 'processing' | 'done' | 'failed';
export type ParseErrorCode = 'not_a_receipt' | 'ai_failed' | 'save_failed';

export interface BillBatchItem {
  id: string;
  position: number;               // 0-based order in the upload
  status: BatchItemStatus;
  bill_id: string | null;         // draft (done) or failed bill; null while queued/processing
  parse_error_code: ParseErrorCode | null;
  parse_error_message: string | null;
}

export interface BillBatch {
  batch_id: string;
  created_at: string;             // ISO timestamp
  total: number;
  completed: boolean;             // true when no item is queued or processing
  items: BillBatchItem[];         // ordered by position
}
```

Example `202` body:

```json
{
  "batch_id": "6f1c…",
  "created_at": "2026-11-02T10:00:00.000Z",
  "total": 3,
  "completed": false,
  "items": [
    { "id": "a1…", "position": 0, "status": "queued", "bill_id": null, "parse_error_code": null, "parse_error_message": null },
    { "id": "b2…", "position": 1, "status": "queued", "bill_id": null, "parse_error_code": null, "parse_error_message": null },
    { "id": "c3…", "position": 2, "status": "queued", "bill_id": null, "parse_error_code": null, "parse_error_message": null }
  ]
}
```

---

## 2. Progress over SSE

### 2.1 Connecting

`GET /households/{hid}/bills/events` is a `text/event-stream`. Browsers' built-in
`EventSource` cannot send an `Authorization` header and **the token must not go in
the URL**, so use `fetch` streaming, e.g.
[`@microsoft/fetch-event-source`](https://www.npmjs.com/package/@microsoft/fetch-event-source):

```ts
import { fetchEventSource } from '@microsoft/fetch-event-source';

class FatalStreamError extends Error {}

export function listenBillEvents(
  hid: string,
  handlers: {
    onEvent: (type: BillEventType, data: BillEventData) => void;
    onReconnected: () => void; // refetch open batches here
  },
): () => void {
  const ctrl = new AbortController();
  let opened = false;

  void fetchEventSource(`${API_URL}/households/${hid}/bills/events`, {
    signal: ctrl.signal,
    // Called for every (re)connect: always send the current token.
    headers: { Authorization: `Bearer ${getAccessToken()}` },
    openWhenHidden: true,
    async onopen(res) {
      if (res.ok && res.headers.get('content-type')?.startsWith('text/event-stream')) {
        if (opened) handlers.onReconnected();
        opened = true;
        return;
      }
      if (res.status === 401) {
        await refreshAccessToken(); // then let it retry
        throw new Error('token refreshed');
      }
      // 403 (not a member), 503 (batch disabled): do not retry.
      throw new FatalStreamError(String(res.status));
    },
    onmessage(msg) {
      if (msg.event === 'ping' || !msg.data) return; // heartbeat
      handlers.onEvent(msg.event as BillEventType, JSON.parse(msg.data));
    },
    onclose() {
      // The server ended the stream (access token expired): reconnect.
      throw new Error('stream closed');
    },
    onerror(err) {
      if (err instanceof FatalStreamError) throw err; // stop
      return 2000; // retry after 2 s
    },
  });

  return () => ctrl.abort();
}
```

`fetchEventSource` reads `headers` once per call. To send a fresh token on every
reconnect, either pass a getter-based wrapper or restart `listenBillEvents` from
`onclose`/`onerror` with a new token. The important part: **every connection uses
the current access token.**

### 2.2 Rules

- **Ignore `ping`.** The server sends an event named `ping` with empty data every
  25 s so proxies keep the connection open.
- **The stream ends when the access token expires.** That is deliberate: a member
  removed from the household stops getting events. Treat a closed stream as
  normal — refresh the token if needed and reconnect.
- **After every reconnect, refetch** the batches the UI still shows as running
  (`GET bill-batches/{id}` for each batch with `completed: false`). Events sent
  while the stream was down are not replayed.
- One stream per household is enough; all members of the household get its events.
  Each payload has `created_by_user_id`: **show toasts only to the uploader**,
  but refresh lists for everyone.
- Events of one batch arrive in order per photo; photos are parsed in parallel, so
  events of different positions interleave.

### 2.3 Events

| `event:` | `data:` |
|---|---|
| `item.processing` | `{ batch_id, item_id, position, status: "processing", created_by_user_id }` |
| `item.done` | same + `bill_id` (the draft) |
| `item.failed` | same + `bill_id` (the failed bill), `parse_error_code`, `parse_error_message` |
| `batch.completed` | `{ batch_id, total, done, failed, created_by_user_id }` — once, after the last item |

```ts
export type BillEventType =
  | 'item.processing' | 'item.done' | 'item.failed' | 'batch.completed';

export interface ItemEventData {
  batch_id: string;
  item_id: string;
  position: number;
  status: BatchItemStatus;
  created_by_user_id: string | null;
  bill_id?: string;
  parse_error_code?: ParseErrorCode;
  parse_error_message?: string;
}

export interface BatchCompletedData {
  batch_id: string;
  total: number;
  done: number;
  failed: number;
  created_by_user_id: string | null;
}

export type BillEventData = ItemEventData | BatchCompletedData;
```

An item can go back from `processing` to `queued` when the user's per-minute AI
limit is reached; the server re-queues it without using up a try. You may then see
`item.processing` again for the same item. Show it as "waiting".

A photo is tried up to 3 times (server setting) before it becomes `ai_failed`.

### 2.4 Example stream

```
event: item.processing
id: 1d0e…
data: {"batch_id":"6f1c…","item_id":"a1…","position":0,"status":"processing","created_by_user_id":"u-1"}

event: item.done
id: 7a2b…
data: {"batch_id":"6f1c…","item_id":"a1…","position":0,"status":"done","bill_id":"d-1","created_by_user_id":"u-1"}

event: item.failed
id: 9c3d…
data: {"batch_id":"6f1c…","item_id":"b2…","position":1,"status":"failed","bill_id":"f-1","parse_error_code":"not_a_receipt","parse_error_message":"The photo is not a receipt or no items were recognized on it","created_by_user_id":"u-1"}

event: ping
data:

event: batch.completed
id: 4e5f…
data: {"batch_id":"6f1c…","total":3,"done":2,"failed":1,"created_by_user_id":"u-1"}
```

### 2.5 Batch state

```
GET /households/{hid}/bill-batches/{id}  →  200 BillBatch
```

Use it after a reconnect, on page load for batches the app remembers (e.g. in
`sessionStorage`), and when no stream is open. `404` when the batch does not
exist in this household.

---

## 3. Results

### 3.1 Drafts

Each `done` item's `bill_id` is an ordinary draft. Review and confirm it exactly as
in [frontend-parse-photo-integration.md](frontend-parse-photo-integration.md)
section 4 (photo via `GET bills/drafts/{id}/image`, confirm via
`POST bills/{id}/confirm`). Drafts also show up in `GET bills/drafts`.

If a photo in the batch is the same image as an open draft, the item ends `done`
with **that existing draft's** `bill_id`; no new draft is created.

### 3.2 The failed group

List failed bills with:

```
GET /households/{hid}/bills/drafts?status=failed&page=1&limit=20
```

It has the same shape as the drafts list; each bill has `status: "failed"`,
`parse_error_code`, `parse_error_message`, `total_amount: 0`, today's
`bill_date` (with `bill_date_inferred: true`) and no lines. The photo is available
with `GET bills/drafts/{id}/image`.

Show them as a separate group ("Couldn't read these receipts") with three actions:

| Action | Call | Result |
|---|---|---|
| **Retry** | `POST bills/{id}/retry` (no body) | `202` with a **new one-item batch**. The failed bill is removed at once; its photo is parsed again and the new item ends as a draft or a new failed bill. Follow it via SSE or `GET bill-batches/{batch_id}`. |
| **Enter manually** | `PUT bills/{id}` with the user's data, then `POST bills/{id}/confirm` | The failed bill becomes a confirmed bill; `parse_error_*` are cleared. |
| **Delete** | `DELETE bills/{id}` | `204`; the bill disappears from the list. |

Retry costs one AI request against the user's limits (section 4.2) and answers
`409` when the bill is not a failed bill with a stored photo (e.g. already retried
or confirmed in another tab), `404` when it does not exist. Offer Retry mostly for
`ai_failed`; for `not_a_receipt` suggest "Enter manually" or "Delete" first, since
the same photo is likely to fail again.

Enter manually — the `PUT` and `confirm` bodies are the ones of
[frontend-update-bill-integration.md](frontend-update-bill-integration.md) and
[frontend-confirm-bill-integration.md](frontend-confirm-bill-integration.md). A
failed bill has no lines, so new lines need a `raw_name` or a `sub_category_id`:

```ts
// Optional: save as the user types (the bill stays "failed").
const { data: saved } = await api.put(`/households/${hid}/bills/${id}`, {
  bill_date: '2026-11-01',
  total_amount: 7.5,
  items: [{ raw_name: 'Bread', product_count: 1, amount: 7.5 }],
});

// Then confirm, keeping the saved line ids.
await api.post(`/households/${hid}/bills/${id}/confirm`, {
  bill_date: '2026-11-01',
  total_amount: 7.5,
  items: saved.items.map((l) => ({ id: l.id, product_count: 1, amount: 7.5 })),
});
```

Skipping the `PUT` and confirming directly with new lines works as well.

### 3.3 Error codes and messages of a failed photo

| `parse_error_code` | `parse_error_message` (shown as is) | Suggested UI |
|---|---|---|
| `not_a_receipt` | The photo is not a receipt or no items were recognized on it | Enter manually / Delete |
| `save_failed` | The bill was recognized but the draft could not be saved; enter it manually | Enter manually |
| `ai_failed` | Daily AI budget reached; retry tomorrow | Retry tomorrow / Enter manually |
| `ai_failed` | The AI service is unavailable; retry later | Retry |
| `ai_failed` | Processing failed; retry later | Retry |
| `ai_failed` | The photo could not be queued; retry later | Retry |

Display `parse_error_message`; branch on `parse_error_code` only.

---

## 4. Errors of the upload and retry calls

### 4.1 Status codes

The error body is `{ statusCode, error, message, request_id }` (`request_id` is
always `null` here).

| Status | When | UI |
|---|---|---|
| `400` | No file, more than 20 files, an extra form field, a file that cannot be decoded or is too large in pixels (`"File N: …"`) | Show `message`; let the user remove file N |
| `401` | Token missing or expired | Refresh the token and repeat |
| `403` | Not a member of the household | Leave the household view |
| `404` | Retry: bill not found | Refresh the failed list |
| `409` | Retry: the bill is no longer a failed bill with a photo | Refresh the failed list |
| `413` | One file over 10 MB | Ask to resize / drop the file |
| `415` | A file that is not JPEG/PNG/WebP, incl. HEIC (`"File N: …"`) | Show `message` |
| `429` | AI limits (section 4.2) | See below |
| `503` | `"Batch photo parsing is disabled"` (no `Retry-After`) | Hide the multi-photo entry; use single parse-photo |
| `503` + `Retry-After: 5` | Upload only: `"Too many batch uploads in progress, try again shortly"`; the server is busy with other uploads. Nothing was read, stored or counted | Retry the same upload after `Retry-After` seconds (a few times, with backoff); keep the selection |

### 4.2 `429` and limits

The batch counts against the same per-user AI limits as single parse-photo. A
batch of N photos uses **N** of the daily quota up front: if the remaining quota is
smaller than N the whole upload is refused and nothing is stored. A refused upload
costs only the one request itself, so a smaller batch (or a single photo) that fits
the remaining quota is still accepted right away.

| Case | Response |
|---|---|
| Daily AI requests (default 100 per 24 h) would be exceeded by the batch | `429` + `Retry-After`, message `"AI request limit reached: 100 per 24 hours. Try again in N s."` |
| Per-minute limit of the upload request itself (default 10) | `429` + `Retry-After` |
| Daily AI spend budget reached | `429`, **no** `Retry-After`, message starting `"Daily AI budget exceeded"` |

Rules:

- `429` **with** `Retry-After`: offer the upload again after that many seconds, or
  suggest fewer photos. Do not retry in a loop.
- `429` **without** `Retry-After` (budget): retrying today will not help; offer
  manual entry.
- The per-minute limit inside the worker never fails the upload: photos simply wait
  in the queue (`item.processing` → back to queued, see 2.3).

> **Known gap (backend):** CORS does not expose `Retry-After` to a cross-origin SPA
> (no `exposedHeaders`). Until it does, read the seconds from `message`
> ("Try again in N s").

---

## 5. UX checklist

- [ ] Open the event stream for the current household before uploading.
- [ ] Show each selected photo with its `position` and a status chip: queued,
      processing, done (→ open draft), failed (→ show message).
- [ ] Ignore `ping`; reconnect when the stream ends and refetch running batches.
- [ ] Toasts only when `created_by_user_id` is the current user.
- [ ] On `batch.completed`, show "N of M receipts read" and link the failed group.
- [ ] Failed group from `GET bills/drafts?status=failed` with Retry / Enter manually
      / Delete.
- [ ] Map `413`/`415`/`400 "File N: …"` to the right thumbnail.
- [ ] On `503` "disabled", fall back to the single-photo flow.
- [ ] On `503` with `Retry-After` ("busy"), retry the upload after that delay;
      tell `503` busy from `503` disabled by the header or `message`.

## 6. Testing against a local backend

- Run Redis (`docker compose up -d redis`) and start the backend with
  `BILL_BATCH_ENABLED=true` (the default).
- The worker runs inside the API process; `BILL_BATCH_CONCURRENCY` photos are parsed
  at once.
- Watch the stream from a shell:

  ```bash
  curl -N -H "Authorization: Bearer $TOKEN" \
    http://localhost:3000/households/$HID/bills/events
  ```

- Upload:

  ```bash
  curl -H "Authorization: Bearer $TOKEN" \
    -F images=@r1.jpg -F images=@r2.jpg \
    http://localhost:3000/households/$HID/bills/parse-photos
  ```

- The backend's end-to-end coverage of this flow is `test/bill-batch.e2e-spec.ts`.
