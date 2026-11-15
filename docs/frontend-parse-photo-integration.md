# Frontend Integration: Receipt Photo Parsing

`POST /households/{hid}/bills/parse-photo`

## Overview

This guide is for frontend developers who build the "scan a receipt" flow. The user
takes or picks a photo of a grocery receipt. The API reads it with AI, matches each
line to a household sub-category, saves the result as a **draft bill** and returns it.
The user then reviews the draft and confirms it, which turns it into a real bill.

The parse-photo call creates the draft. It does not create a confirmed bill.

```
 ┌────────────┐   multipart    ┌──────────────────────────┐
 │ Pick/take  │ ─────────────▶ │ POST .../parse-photo     │  10–90 s
 │ photo      │                │  → draft + parsed items  │
 └────────────┘                └────────────┬─────────────┘
                                            │ 200
                                            ▼
                              ┌──────────────────────────┐
                              │ Review screen            │◀── GET .../drafts/{id}/image
                              │ (edit lines, categories) │    (photo next to the draft)
                              └────────────┬─────────────┘
                                           │
                                           ▼
                              ┌──────────────────────────┐
                              │ POST .../bills/{id}/confirm│
                              └──────────────────────────┘
```

Related endpoints used by the flow:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/households/{hid}/bills/parse-photo` | Upload a photo and get a draft back |
| `GET` | `/households/{hid}/bills/drafts?page=&limit=` | List open drafts, newest first (resume unfinished reviews) |
| `GET` | `/households/{hid}/bills/drafts/{id}/image` | Get a short-lived URL of the draft's photo |
| `POST` | `/households/{hid}/bills/{id}/confirm` | Confirm the draft with the user's edits |
| `DELETE` | `/households/{hid}/bills/{id}` | Discard a draft |

Swagger UI with the live schemas is served at `/api` on the backend.

---

## 1. Request

### 1.1 Contract

| | |
|---|---|
| Method | `POST` |
| Path | `/households/{hid}/bills/parse-photo` (no global prefix) |
| Auth | `Authorization: Bearer <access_token>` |
| Body | `multipart/form-data` with exactly **one** file field named **`image`** |
| Success | `200 OK` (not 201) |

The multipart body has strict rules. A request that breaks them gets `400`:

- The file field name must be `image`.
- Send exactly one file.
- Send **no other fields**: no text fields, no metadata. The server accepts `fields: 0`.

### 1.2 File requirements

| Rule | Value | Error if broken |
|---|---|---|
| Formats | JPEG, PNG, WebP | `415` |
| HEIC / HEIF (iPhone default) | **Rejected** | `415` with a hint to switch the camera format |
| Max file size | 10 MB (10 × 1024 × 1024 bytes) | `413` |
| Max resolution | 100 megapixels | `413` |
| Corrupt or undecodable file | — | `422` |

The server detects the type from the file's bytes. **It ignores the `Content-Type`
you send and the file extension.** A renamed `.heic` file is still rejected.

The server then re-encodes every photo as a JPEG. It fixes the EXIF rotation, scales
the photo down to at most 2000 px per side, flattens transparency onto white and
removes all metadata, including GPS. Only this cleaned image is stored in S3 and
sent to the AI provider.

### 1.3 Client-side preparation (recommended)

Pixels above 2000 px per side are thrown away on the server. Sending them only costs
upload time and mobile data. Before uploading:

1. **Restrict the picker** so iOS converts HEIC for you:
   ```html
   <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" />
   ```
   When `accept` lists only these types, iOS Safari usually hands over a JPEG instead
   of HEIC. Still handle `415`, because not every browser or picker does this.
2. **Downscale** to at most 2000 px on the longest side and encode as JPEG (quality
   about 0.85). A typical receipt is then 300–800 KB instead of 3–6 MB.
3. **Check the size** (≤ 10 MB) and type before sending, so the user gets an error
   at once and does not wait for the upload.

```ts
// utils/prepareReceiptPhoto.ts
const MAX_SIDE = 2000;
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export async function prepareReceiptPhoto(file: File): Promise<Blob> {
  if (!ACCEPTED.includes(file.type)) {
    throw new Error('Please choose a JPEG, PNG or WebP photo.');
  }
  // imageOrientation: 'from-image' applies EXIF rotation before we draw.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_BYTES) {
    bitmap.close();
    return file; // already small enough; send the original bytes
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // PNG transparency → white, as the server does
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) =>
    canvas.toBlob(r, 'image/jpeg', 0.85),
  );
  if (!blob) throw new Error('Could not process the photo.');
  if (blob.size > MAX_BYTES) throw new Error('The photo is larger than 10 MB.');
  return blob;
}
```

> **Duplicate detection and resizing.** The server detects a re-uploaded photo by
> a hash of its *own* re-encoded image (see [§2.3](#23-duplicates-duplicate-true)).
> Uploading the same original file twice through the same pipeline is detected.
> A different client-side resize or quality setting produces different bytes and may
> not be detected, so keep the preparation step fixed.

### 1.4 Calling the API

Do **not** set `Content-Type` yourself. The browser must add the multipart boundary.

```ts
// api/bills.api.ts
import { apiClient } from './client'; // axios instance with the Bearer interceptor
import type { ParsePhotoResponse } from './types/parsePhoto';

// Server budget: up to 90 s for the AI step, plus the upload and storage.
const PARSE_PHOTO_TIMEOUT_MS = 120_000;

export async function parseReceiptPhoto(
  householdId: string,
  photo: Blob,
  opts: { signal?: AbortSignal; onUploadProgress?: (pct: number) => void } = {},
): Promise<ParsePhotoResponse> {
  const form = new FormData();
  form.append('image', photo, 'receipt.jpg'); // the only field allowed

  const { data } = await apiClient.post<ParsePhotoResponse>(
    `/households/${householdId}/bills/parse-photo`,
    form,
    {
      timeout: PARSE_PHOTO_TIMEOUT_MS,
      signal: opts.signal,
      onUploadProgress: (e) =>
        e.total && opts.onUploadProgress?.(Math.round((e.loaded / e.total) * 100)),
    },
  );
  return data;
}
```

With `fetch`, use `fetch(url, { method: 'POST', body: form, headers: { Authorization } })`
and leave out `Content-Type` in the same way.

---

## 2. Response

### 2.1 Types

```ts
// api/types/parsePhoto.ts
export type ItemUnit = 'kg' | 'g' | 'l' | 'ml' | 'piece';

export interface SubCategoryRef {
  id: string;            // uuid
  name: string;          // e.g. "bun"
  category_name: string; // e.g. "Bread"
}

export interface ParsedBillItem {
  id?: string;                    // draft line id; send it back in confirm
  name: string;                   // as printed on the receipt, e.g. "BREAD"
  quantity: number | null;        // piece count; null for weighed items
  unit: ItemUnit | null;
  weight_kg: number | null;       // set for weighed items
  price_per_kg: number | null;    // unit price (per kg, l or piece; see unit)
  final_price: number;            // paid for the line, after discounts
  sub_category: SubCategoryRef | null; // null = AI found no good match
  category_confidence: number;    // 0..1
  category_reasoning?: string;    // why the AI picked the sub-category
}

export interface ParsedBill {
  draft_id: string;               // uuid of the saved draft
  market_name: string | null;     // store name as read, e.g. "Lidl"
  bill_date: string | null;       // "YYYY-MM-DD"; null if no date was read
  currency: string | null;        // ISO 4217, e.g. "EUR"
  total_amount: number | null;
  items: ParsedBillItem[];
}

export interface ParsePhotoResponse extends ParsedBill {
  request_id: string | null;      // audited AI request id (support/debug)
  duplicate: boolean;             // true = existing draft returned, no AI call
}

export interface AiErrorBody {
  statusCode: number;
  error: string;                  // HTTP reason phrase, e.g. "Unprocessable Entity"
  message: string;                // safe to show to the user
  request_id: string | null;
  parsed?: ParsedBill;            // only on the "draft could not be saved" 422
}
```

### 2.2 Example

```json
{
  "draft_id": "5b1f0c1e-8a43-4c34-9d7e-0f6f1f2b9a10",
  "market_name": "Lidl",
  "bill_date": "2026-10-28",
  "currency": "EUR",
  "total_amount": 10.19,
  "items": [
    {
      "id": "e3c1...",
      "name": "BREAD",
      "quantity": 1,
      "unit": "piece",
      "weight_kg": null,
      "price_per_kg": null,
      "final_price": 1.2,
      "sub_category": { "id": "0000...0001", "name": "bun", "category_name": "Bread" },
      "category_confidence": 0.94,
      "category_reasoning": "Piece-priced bread product."
    },
    {
      "id": "a7d2...",
      "name": "BANANE",
      "quantity": null,
      "unit": "kg",
      "weight_kg": 1.234,
      "price_per_kg": 7.29,
      "final_price": 8.99,
      "sub_category": null,
      "category_confidence": 0.31
    }
  ],
  "request_id": "9f3e2b7a-...",
  "duplicate": false
}
```

### 2.3 Duplicates (`duplicate: true`)

If the same photo was already uploaded to this household and its draft is still
open, the server returns **that draft** with `duplicate: true`. It makes no AI call,
so this answer is fast and does not count toward the AI budget. (It still counts
toward the per-user rate limit, see §3.)

UI suggestion: open the review screen as usual and show a note such as *"You already
scanned this receipt. Continuing the existing draft."*

`request_id` can be `null` here when the original AI request record was purged.

A photo whose draft was already confirmed or deleted is not a duplicate. Uploading
it again creates a new draft and makes a new AI call.

### 2.4 Rendering notes

- **Each receipt line is one item.** Lines are not merged, even when they share a
  sub-category.
- **Weighed vs. counted items.** Weighed items have `weight_kg` set and
  `quantity: null`. Counted items have `quantity` set and `weight_kg: null`.
- **`price_per_kg`** is the unit price. Read `unit` to label it (per kg, per l, per
  piece).
- **`final_price`** is the amount paid after discounts. It is the value to show and
  to sum.
- **Low confidence.** `sub_category: null` or a low `category_confidence` (we
  suggest below `0.6`) should be highlighted so the user picks a category.
  `category_reasoning` works well as a tooltip.
- **Missing header fields.** `bill_date: null` means no date was read; the draft
  stores the upload day, so pre-fill today and let the user change it.
  `market_name`, `currency` and `total_amount` can also be `null` and must then be
  entered on the review screen.
- **Totals.** Compare `sum(final_price)` with `total_amount` and warn on a
  difference. The server does not reject a mismatch; it flags the bill with
  `amount_mismatch`.

---

## 3. Errors

### 3.1 One error shape

**Every** error from this endpoint, including auth and upload errors, has the same
body:

```json
{
  "statusCode": 503,
  "error": "Service Unavailable",
  "message": "AI providers are unavailable, try again later",
  "request_id": "9f3e2b7a-..."
}
```

`message` is written for end users and can be shown as is. `request_id` is `null`
when the request failed before the AI call was audited (auth, upload checks,
limits). When it is set, show it as a "reference" in the error UI and send it to
logging, so support can find the AI call.

### 3.2 Status codes and what the UI should do

| Status | When | Retry? | Suggested UI |
|---|---|---|---|
| `400` | Missing `image`, more than one file, or extra form fields | No (client bug) | Generic error; log it |
| `401` | Missing or expired JWT | After refresh | The normal token-refresh interceptor; replay once |
| `403` | User is not a member of household `hid` | No | "You don't have access to this household" |
| `413` | File > 10 MB, or image > 100 MP | No | "Photo is too large. Try a smaller one." |
| `415` | Not JPEG/PNG/WebP, **including HEIC** | No | Show `message` (it includes the iPhone fix) |
| `422` | See §3.3 (four cases) | Depends | See §3.3 |
| `429` | Per-user limit or daily AI budget reached | Later | Show `message`; disable the button until `Retry-After` |
| `502` | AI providers failed for mixed reasons | Yes, once | "Recognition failed. Try again." |
| `503` | AI busy or down, storage failed, or feature not configured | If `Retry-After` is present | See §3.4 |

### 3.3 The four `422` cases

All four share the status, so tell them apart by the body:

| Case | How to detect | `request_id` | What to do |
|---|---|---|---|
| Image could not be decoded | `request_id === null` | `null` | Ask for another photo |
| AI providers rejected the image | `message` contains "retake the photo" | set | Ask the user to retake the photo (blur, glare, cropping) |
| Not a receipt / no items found | `message` starts with "The photo is not a receipt" | set | "We couldn't find a receipt in this photo." No draft was saved |
| **Recognized, but the draft could not be saved** | **`parsed` is present** | set | **Do not ask for a new upload.** Open the review screen with `parsed` and save with `POST /bills` (manual create), see §4.4 |

The last case matters because the AI call has already been paid for. Asking the
user to upload again would pay for it twice. In this case `parsed.draft_id` is an
empty value, so there is no draft to confirm.

Match on `parsed` and `request_id`. They are part of the contract. Message text
may change, so use it only to tell apart the two remaining cases.

### 3.4 Rate limits, budget and `Retry-After`

Limits are per user, across all their households. Defaults, configurable on the
server:

| Limit | Default | Response |
|---|---|---|
| AI requests per minute | 10 | `429` + `Retry-After` |
| AI requests per 24 h | 100 | `429` + `Retry-After` |
| AI spend per user per 24 h | $1 | `429`, **no** `Retry-After` |
| Concurrent AI calls per server instance | 4 | `503` + `Retry-After: 10` |
| AI providers rate-limited, failing or timing out | — | `503` + `Retry-After: 30` |
| Photo could not be stored in S3 | — | `503` + `Retry-After: 30` |
| Photo recognition not configured | — | `503`, **no** `Retry-After` |

Rules for the client:

- **`Retry-After` present:** offer a retry after that many seconds, for example a
  countdown on the button. Do not retry automatically in a loop.
- **`503` without `Retry-After`:** the feature is off on this server. Hide or disable
  the scan entry point for the session and offer manual bill entry.
- **`429` without `Retry-After`** (budget): retrying today will not help. Show
  `message` and offer manual entry.

Read the header from axios as `error.response.headers['retry-after']`.

> **Known gap (backend):** the CORS config in `src/app.setup.ts` does not set
> `exposedHeaders`. The SPA runs on a different origin (`FRONTEND_URL`, default
> `http://localhost:5173`), so the browser **hides `Retry-After`** from JavaScript
> until the backend adds `exposedHeaders: ['Retry-After']`. Until then, treat a
> missing header on `429`/`503` as "unknown". Fall back to 30 s for `503`, use the
> seconds in the `429` `message` ("Try again in N s"), and do **not** treat it as
> "feature not configured". That case has the message *"Photo recognition is not
> available"*.

### 3.5 Error helper

```ts
// api/errors/parsePhotoError.ts
import axios from 'axios';
import type { AiErrorBody, ParsedBill } from '../types/parsePhoto';

export type ParsePhotoFailure =
  | { kind: 'auth' }                                   // 401 (after refresh failed)
  | { kind: 'forbidden' }                              // 403
  | { kind: 'bad-photo'; message: string }             // 413, 415, 422 decode / rejected / not a receipt
  | { kind: 'save-failed'; parsed: ParsedBill; requestId: string | null } // 422 + parsed
  | { kind: 'retry-later'; message: string; retryAfterSec: number }       // 429/503 with Retry-After
  | { kind: 'unavailable'; message: string }           // 503 without Retry-After, 429 budget
  | { kind: 'failed'; message: string; requestId: string | null }         // 400, 502, network, timeout
  | { kind: 'cancelled' };

export function toParsePhotoFailure(err: unknown): ParsePhotoFailure {
  if (axios.isCancel(err)) return { kind: 'cancelled' };
  if (!axios.isAxiosError<AiErrorBody>(err) || !err.response) {
    const timedOut = axios.isAxiosError(err) && err.code === 'ECONNABORTED';
    return {
      kind: 'failed',
      message: timedOut
        ? 'Recognition is taking too long. Check your drafts in a moment.'
        : 'Network error. Check your connection and try again.',
      requestId: null,
    };
  }

  const { status, data, headers } = err.response;
  const message = data?.message ?? 'Something went wrong';
  const requestId = data?.request_id ?? null;
  const retryAfter = Number(headers['retry-after']);

  switch (status) {
    case 401: return { kind: 'auth' };
    case 403: return { kind: 'forbidden' };
    case 413:
    case 415: return { kind: 'bad-photo', message };
    case 422:
      if (data?.parsed) return { kind: 'save-failed', parsed: data.parsed, requestId };
      return { kind: 'bad-photo', message };
    case 429:
    case 503: {
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return { kind: 'retry-later', message, retryAfterSec: retryAfter };
      }
      // Retry-After may be hidden by CORS (see §3.4), so decide by the body too.
      const notConfigured = status === 503 && message === 'Photo recognition is not available';
      const budgetSpent = status === 429 && message.startsWith('Daily AI budget exceeded');
      if (notConfigured || budgetSpent) return { kind: 'unavailable', message };
      const inMessage = Number(/in (\d+) s/.exec(message)?.[1]);
      return { kind: 'retry-later', message, retryAfterSec: inMessage || 30 };
    }
    default:
      return { kind: 'failed', message, requestId };
  }
}
```

### 3.6 Timeouts and lost responses

The server gives the AI step up to **90 s** (60 s per provider call, with retries
and fallback providers inside that budget). Most receipts take 5–20 s. Set the
client timeout to about **120 s**, which also covers the upload on a slow
connection.

If the client times out or the connection drops, the server may still finish and
save the draft. Do not retry the upload blindly. Either:

- open the **drafts list** (`GET /drafts`) and look for the new draft, or
- upload the **same** prepared blob again. If the draft was saved, the server
  returns it as `duplicate: true` with no new AI call.

Keep the prepared `Blob` in memory until the request succeeds, so a retry sends the
same bytes.

---

## 4. Review and confirm

### 4.1 Showing the photo next to the draft

```
GET /households/{hid}/bills/drafts/{draftId}/image
→ 200 { "url": "https://...presigned...", "expires_in": 300 }
```

The URL is valid for **5 minutes**. Use it directly in `<img src>`. Do not store it.
If the image fails to load after a while (`onError`), fetch a new URL. `404` means
the draft has no stored photo.

### 4.2 Resuming drafts

```
GET /households/{hid}/bills/drafts?page=1&limit=20   (limit max 100)
→ { data: BillDetailResponse[], meta: { ...pagination } }
```

Drafts survive reloads and can be confirmed later from any device in the household.
The server soft-deletes drafts that are not confirmed within **30 days** (default),
so show a "pending receipts" list or badge so users finish them.

The drafts list uses the **stored bill shape** (`raw_name`, `product_count`,
`amount`, `product_weight`, `price_per_unit`, `bill_date_inferred`, ...), not the
parse-photo shape. If one review screen handles both entry points, map both into
the same view model.

### 4.3 Confirming

```
POST /households/{hid}/bills/{draftId}/confirm
```

Full guide: [frontend-confirm-bill-integration.md](frontend-confirm-bill-integration.md).

```ts
export interface ConfirmBillItem {
  id?: string;              // draft line id → updates that line in place
  sub_category_id?: string; // omit to confirm without a sub-category
  raw_name?: string;        // required on a NEW line without a sub-category
  product_count: number;    // integer ≥ 1
  amount: number;           // > 0, max 2 decimals
  product_weight?: number;  // kg, > 0, max 3 decimals
}

export interface ConfirmBillRequest {
  market_id?: string;                  // existing market, or
  new_market?: { name: string; city?: string; country?: string; address?: string };
  bill_date: string;                   // "YYYY-MM-DD", required
  currency?: string;                   // ISO 4217
  total_amount: number;                // > 0, max 2 decimals, required
  description?: string;
  items: ConfirmBillItem[];            // 1..200
}
```

Mapping from the parse-photo response:

| Parsed field | Confirm field | Notes |
|---|---|---|
| `items[].id` | `items[].id` | Keep it, so the line is updated in place and keeps the AI data (unit, confidence) |
| `items[].sub_category?.id` | `items[].sub_category_id` | Omit when `null` |
| `items[].name` | `items[].raw_name` | Optional for existing lines |
| `items[].quantity` | `items[].product_count` | Use `quantity ?? 1`; must be an integer ≥ 1 |
| `items[].final_price` | `items[].amount` | Round to 2 decimals |
| `items[].weight_kg` | `items[].product_weight` | Omit when `null` |
| `market_name` | `new_market.name` or `market_id` | Let the user pick an existing market when possible |
| `bill_date` | `bill_date` | Required; default to today when `null` |
| `currency` | `currency` | |
| `total_amount` | `total_amount` | Required; the user must fill it when `null` |

Rules:

- **Draft lines you leave out of `items` are deleted.** To delete a line, drop it
  from the array.
- New lines (added by the user) have no `id`. Without a `sub_category_id` they need
  a `raw_name`.
- Sending the same `id` twice gives `400`.

Errors: `400` invalid market or sub-category reference, or validation; `404` draft
not found (deleted or expired); `409` already confirmed (another household member
or another tab confirmed it, so refresh and show the bill). These endpoints use the
standard NestJS error body `{ statusCode, message, error }` (validation errors have
`message` as an array of strings). It has no `request_id`.

### 4.4 Fallback when the draft could not be saved

For the `422` with `parsed` (§3.3), there is no draft to confirm. Open the same
review screen with `parsed`, but on save call `POST /households/{hid}/bills`
(`CreateBillDto`: the same fields as confirm, but each item **requires**
`sub_category_id` and has no `id`/`raw_name`). Lines without a sub-category must be
categorized before saving.

---

## 5. UX checklist

- [ ] The picker accepts only JPEG/PNG/WebP and opens the rear camera on mobile.
- [ ] Photo is downscaled to ≤ 2000 px before upload; size checked on the client.
- [ ] Progress shows two phases: *Uploading… (n%)*, then *Reading receipt…* (can take
      up to a minute and a half).
- [ ] The scan button is disabled while a request is running (prevents duplicate AI calls).
- [ ] The user can cancel (`AbortController`). The server may still save the draft, so it appears in drafts.
- [ ] `duplicate: true` shows a "continuing existing draft" note.
- [ ] Low-confidence or uncategorized lines are highlighted on the review screen.
- [ ] A sum vs. total mismatch is shown before confirm.
- [ ] The receipt photo is shown next to the draft, and the URL is refreshed after 5 minutes.
- [ ] `422` with `parsed` falls back to manual create and never asks for a re-upload.
- [ ] `Retry-After` shows a countdown; `503` without it hides the feature.
- [ ] The error UI shows `request_id` as a reference code when it is present.
- [ ] A pending-drafts badge or list exists (drafts expire after 30 days).

---

## 6. Testing against a local backend

```bash
curl -X POST "http://localhost:3000/households/$HID/bills/parse-photo" \
  -H "Authorization: Bearer $TOKEN" \
  -F "image=@receipt.jpg"
```

Useful cases to try: a non-receipt photo (`422`), a `.heic` file (`415`), a file
over 10 MB (`413`), the same photo twice (`duplicate: true`), and a backend with no
AI provider configured (`503` without `Retry-After`). Lower
`AI_USER_LIMIT_PER_MINUTE` in the backend `.env` to test the `429` UI.
