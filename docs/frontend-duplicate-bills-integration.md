# Frontend Integration: Duplicate Bills

## Overview

The same purchase can enter a household more than once: two members upload the
same receipt, someone uploads it again after confirming it, or a bill typed by hand
is also uploaded as a photo. Counting every copy overstates spending.

The backend **finds likely duplicates and shows them to the user**. The user
decides. Nothing is marked automatically and no endpoint is blocked by a possible
duplicate. A bill **marked as a duplicate** stays in the database, but it is
**counted once** (through its original) in the dashboard, the spending breakdown,
the market bill counts and every total.

```
 parse-photo ─▶ draft ─┬─▶ confirm ──────────────▶ confirmed bill ─┐
 (possible_duplicates) │   (duplicate_of_id?)                      │  mark-duplicate
                       │                                           ├─────────────▶ duplicate bill
 POST /bills ──────────┘   (duplicate_of_id?)                      │◀───────────── (unmark-duplicate)
                                                                   │
 GET /bills/duplicate-suggestions ─▶ pairs ─▶ mark-duplicate | dismiss-duplicate
```

All paths start with `/households/{hid}/bills` (no global prefix). `hid` is the
household uuid and the user must be a member. Auth is
`Authorization: Bearer <access_token>`. Swagger UI with the live schemas is served
at `/api` on the backend.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/bills/parse-photo` | Draft response now has `possible_duplicates` (§2) |
| `GET` | `/bills/{id}` | `possible_duplicates` or `duplicate_of` (§2) |
| `POST` | `/bills` | Create; optional `duplicate_of_id` (§3) |
| `POST` | `/bills/{id}/confirm` | Confirm; optional `duplicate_of_id` (§3) |
| `POST` | `/bills/{id}/mark-duplicate` | Mark a confirmed bill as a duplicate (§4) |
| `POST` | `/bills/{id}/unmark-duplicate` | Count a duplicate again (§5) |
| `GET` | `/bills/duplicate-suggestions` | Pairs that look like one purchase (§6) |
| `POST` | `/bills/{id}/dismiss-duplicate` | "Keep both": stop suggesting a pair (§7) |
| `GET` | `/bills?include_duplicates=true` | List duplicates too (§8) |
| `DELETE` | `/bills/{id}` | Deleting an original promotes a duplicate (§9) |

---

## 1. The model in one minute

- A bill has a `status`: `draft`, `confirmed` or `duplicate`.
- A duplicate points to its **original** (`duplicate_of`). The original is always a
  live, **confirmed** bill of the same household. There are no chains: when you mark
  a bill as a duplicate of a duplicate, the server links it to that bill's original.
- Only `confirmed` bills are counted. A duplicate is never counted.
- A draft is never marked directly. To save a draft as a duplicate, pass
  `duplicate_of_id` to **confirm** (§3).
- A bill marked as a duplicate can still be edited (`PUT /bills/{id}`); it stays a
  duplicate.

Receipts are matched by what they print (the fiscal register id and the receipt
number, which the AI reads from the photo), with amount, currency, date and market
or purchase time as the fallback for bills without them.

### 1.1 `PossibleDuplicate`

The same shape is used everywhere a bill is shown as a look-alike or as an original.

```ts
// api/types/duplicates.ts
export type DuplicateMatch = 'fiscal' | 'strong' | 'weak';

export interface PossibleDuplicate {
  id: string;                    // uuid of the other (confirmed) bill
  bill_date: string;             // "YYYY-MM-DD"
  total_amount: number;
  currency: string | null;
  market_name: string | null;
  created_by_name: string | null; // who added it, e.g. "Ana"
  match?: DuplicateMatch;        // absent on `duplicate_of`
}
```

```json
{
  "id": "5d0e7c2e-9f0a-4b34-8f55-0b1c9a1d7a10",
  "bill_date": "2026-10-03",
  "total_amount": 412.5,
  "currency": "MDL",
  "market_name": "Linella",
  "created_by_name": "Ana",
  "match": "fiscal"
}
```

| `match` | Meaning | How sure |
|---|---|---|
| `fiscal` | Same fiscal register id and receipt number | Near certain |
| `strong` | Same currency, amount and date, **and** the same market or the same purchase time | Very likely |
| `weak` | Same currency, amount and date only | Possible; could be two coffees |

Two bills with different receipt numbers on the same register are never candidates:
they are two receipts. Candidates are ordered `fiscal`, `strong`, `weak`, then by
closest date.

---

## 2. Where `possible_duplicates` and `duplicate_of` appear

`possible_duplicates` is always a list (empty when there is nothing). It is
informational: nothing is blocked and the bill is saved regardless.

| Endpoint | Fields | Notes |
|---|---|---|
| `POST /bills/parse-photo` | `possible_duplicates` | **Required** field of the draft response. Computed from the parsed receipt. When no date or total was read, only fiscal ids are compared. Also set when the same photo returns its existing draft (`duplicate: true`, see below). |
| `GET /bills/{id}` | `possible_duplicates`, `duplicate_of` | A draft or confirmed bill: `possible_duplicates` lists confirmed look-alikes (the bill itself is excluded) and `duplicate_of` is `null`. A duplicate bill: `duplicate_of` is its original and `possible_duplicates` is `[]`. |
| `POST /bills` | `possible_duplicates`, `duplicate_of` | Checked after the write. |
| `POST /bills/{id}/confirm` | `possible_duplicates`, `duplicate_of` | Checked after the write. |
| `POST .../mark-duplicate`, `POST .../unmark-duplicate` | `possible_duplicates`, `duplicate_of` | Same as `GET /bills/{id}`. |
| `GET /bills/drafts` | none | Both fields are **optional on `BillDetailResponse` and absent on draft-list rows**. Call `GET /bills/{id}` when the user opens a draft. |

```ts
// additions to BillDetailResponse
export interface BillDetailResponse {
  // ...existing fields (status: 'draft' | 'confirmed' | 'duplicate', ...)
  possible_duplicates?: PossibleDuplicate[]; // absent on draft-list rows
  duplicate_of?: PossibleDuplicate | null;   // absent on draft-list rows
}

// additions to ParsePhotoResponse
export interface ParsePhotoResponse {
  // ...existing fields
  possible_duplicates: PossibleDuplicate[];
}
```

### 2.1 The two different "duplicate" notions in parse-photo

`duplicate: true` on the parse-photo response means **the same photo file was
uploaded again** and its open draft is returned without a new AI call. It is not
about matching purchases. `possible_duplicates` is the new, separate signal: a
*different* bill (confirmed) that may be the same purchase. Handle both.

### 2.2 New receipt fields

The bill detail and parse-photo responses now also carry `fiscal_register_id`,
`fiscal_receipt_number` (strings) and `purchase_time` (`"HH:MM"`), each
`string | null`. Create, confirm and update accept them as optional fields, so a
hand-entered bill can carry a receipt number and a misread one can be corrected. They
raise match quality; showing them in an edit form is optional.

---

## 3. Saving a bill directly as a duplicate: `duplicate_of_id`

`POST /bills` and `POST /bills/{id}/confirm` accept an optional
`duplicate_of_id` (uuid).

```ts
export interface CreateBillRequest /* and ConfirmBillRequest */ {
  // ...existing fields
  duplicate_of_id?: string; // save as a duplicate of this confirmed bill
}
```

- Unset: the bill is created or confirmed as before.
- Set: the bill is saved with `status: "duplicate"` and `duplicate_of` set. It is
  done in the **same transaction** as the create or confirm. If the link is refused,
  nothing is saved (a draft stays a draft, and a new bill is not created), so the
  user can fix the form and retry.
- The target may itself be a duplicate: the link goes to its original.
- Same rules and errors as marking (§4).

Request example (confirm):

```json
{
  "bill_date": "2026-10-03",
  "total_amount": 412.5,
  "currency": "MDL",
  "market_id": "0d6b2a7e-6b3f-4b51-9a3c-2f1f2d9c1a11",
  "duplicate_of_id": "5d0e7c2e-9f0a-4b34-8f55-0b1c9a1d7a10",
  "items": [{ "id": "e3c1b8a4-1f0a-4c7e-8f3b-3d2b1a0c9e77", "product_count": 1, "amount": 412.5 }]
}
```

The `200` (confirm) or `201` (create) response is the bill detail with
`status: "duplicate"` and `duplicate_of`:

```json
{
  "id": "a41b…",
  "status": "duplicate",
  "possible_duplicates": [],
  "duplicate_of": {
    "id": "5d0e7c2e-9f0a-4b34-8f55-0b1c9a1d7a10",
    "bill_date": "2026-10-03",
    "total_amount": 412.5,
    "currency": "MDL",
    "market_name": "Linella",
    "created_by_name": "Ana"
  }
}
```

Errors on both endpoints, when `duplicate_of_id` is sent:

| Status | When |
|---|---|
| `400` | `duplicate_of_id` is not a uuid; or it points to a draft bill (`… is not confirmed, so it cannot be an original`); or it would create a cycle (`… is already a duplicate of this bill`); or it is the bill itself (`A bill cannot be a duplicate of itself`) |
| `404` | `Bill with ID … not found`: the target is missing, deleted or in another household |

Confirm keeps its usual errors. In particular, confirming a bill that is not a draft
(including a duplicate) is `409` `Bill with ID … is not a draft`.

---

## 4. Mark a confirmed bill as a duplicate

`POST /households/{hid}/bills/{id}/mark-duplicate`

| | |
|---|---|
| Body | `{ "duplicate_of_id": "<uuid>" }` |
| Success | `200 OK`, body `BillDetailResponse` with `status: "duplicate"` and `duplicate_of` |

```json
{ "duplicate_of_id": "5d0e7c2e-9f0a-4b34-8f55-0b1c9a1d7a10" }
```

What the server does, in one transaction (both rows locked, so two people marking
at once cannot create a cycle):

- The target may itself be a duplicate: the bill is linked to the target's original.
- If other bills were duplicates **of this bill**, they are re-pointed to the new
  original. There are no chains.
- The bill stops counting in every total; the original keeps counting.

| Status | When |
|---|---|
| `400` | Body is not `{ duplicate_of_id: uuid }`; the target is the bill itself; the target is a draft; a cycle (the target is already a duplicate of this bill) |
| `404` | The bill, or the target, is missing, deleted or in another household |
| `409` | The bill is not confirmed: a draft (`… is not confirmed`; confirm it, passing `duplicate_of_id`, instead) or already a duplicate (`… is already a duplicate; unmark it first`) |
| `401` / `403` | No token / not a member of the household |

---

## 5. Count a duplicate again

`POST /households/{hid}/bills/{id}/unmark-duplicate`

No body. Success `200 OK` with the `BillDetailResponse`: `status: "confirmed"`,
`duplicate_of: null`, and fresh `possible_duplicates`. The bill counts in totals
again.

| Status | When |
|---|---|
| `400` | The bill is not a duplicate (`Bill with ID … is not a duplicate`) |
| `404` | Bill not found |

---

## 6. Suggestions for bills already confirmed

`GET /households/{hid}/bills/duplicate-suggestions?date_from=&date_to=`

Lists pairs of confirmed bills that look like the same purchase, so a household can
clean up double-counting it already has. Pairs the user dismissed (§7) are left out.

| Query | |
|---|---|
| `date_from` | Optional `YYYY-MM-DD`. Only pairs where **both** bills have `bill_date >=` it. |
| `date_to` | Optional `YYYY-MM-DD`. Only pairs where **both** bills have `bill_date <=` it. |

`200 OK`:

```ts
export interface DuplicatePair {
  bill: PossibleDuplicate;   // the bill with the smaller id of the pair
  other: PossibleDuplicate;
  match: DuplicateMatch;
}
export interface DuplicateSuggestionsResponse {
  pairs: DuplicatePair[];    // at most 100, best match first, then newest purchase first
}
```

```json
{
  "pairs": [
    {
      "bill": { "id": "5d0e…", "bill_date": "2026-10-03", "total_amount": 412.5,
                "currency": "MDL", "market_name": "Linella", "created_by_name": "Ana",
                "match": "strong" },
      "other": { "id": "a41b…", "bill_date": "2026-10-03", "total_amount": 412.5,
                 "currency": "MDL", "market_name": "Linella", "created_by_name": "Hang",
                 "match": "strong" },
      "match": "strong"
    }
  ]
}
```

Notes:

- `bill` and `other` are ordered by id, **not** by age. To decide which one to mark,
  compare `bill_date` and who added it, or let the user choose.
- Each pair appears once. A bill that is already a duplicate is not paired.
- Invalid dates, or `date_from` later than `date_to`: `400`.

---

## 7. Keep both: dismiss a pair

`POST /households/{hid}/bills/{id}/dismiss-duplicate`

| | |
|---|---|
| Body | `{ "other_bill_id": "<uuid>" }` |
| Success | `204 No Content`, empty body |

```json
{ "other_bill_id": "a41b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d" }
```

The pair is never suggested again, whichever bill you send as `{id}`: not by
suggestions and not in `possible_duplicates` on either bill's detail, confirm or
create response (so "Keep both" on a bill detail is persistent).
Dismissing the same pair twice is fine (also `204`). The bills themselves are
unchanged and both keep counting. Dismissal also works for a draft bill.

| Status | When |
|---|---|
| `400` | `other_bill_id` is not a uuid, or is the bill itself (`A bill cannot be dismissed against itself`) |
| `404` | Either bill is missing, deleted or in another household |

---

## 8. Listing: `include_duplicates`

`GET /households/{hid}/bills?include_duplicates=true`

By default the list shows **confirmed bills only**; duplicates are hidden, like in
every total. Send `include_duplicates=true` to list duplicates too, for example for
a "show duplicates" toggle or a clean-up screen.

| Value | Result |
|---|---|
| omitted or `false` | confirmed bills only |
| `true` | confirmed and duplicate bills |
| anything else (`yes`, `1`) | `400` |

Every list row now has two more fields (also without the flag):

```ts
export interface BillListItem {
  // ...existing fields
  status: 'confirmed' | 'duplicate';     // 'duplicate' only with include_duplicates=true
  duplicate_of_id: string | null;        // the original's id when status is 'duplicate'
}
```

Use `duplicate_of_id` to grey the row out and link it to the original (it is in the
same list when the filters match it). `meta.total` counts the rows the filter
returns, so it includes duplicates when the flag is set.

Totals are **never** inflated by duplicates, flag or not: the dashboard, the
spending breakdown and the market `bill_count` count each purchase once.

---

## 9. Deleting an original

`DELETE /households/{hid}/bills/{id}`

- Deleting a **duplicate** works as before; the original is untouched.
- Deleting an **original** that has duplicates: in the same transaction, the oldest
  duplicate (by creation time) is **promoted**. It becomes `confirmed` with no link,
  and the other duplicates are re-pointed to it. The purchase is still counted
  exactly once. A duplicate that was itself deleted is never promoted.

After deleting an original, refetch any screen that showed its duplicates: their
`duplicate_of` may now point to a different bill, or a duplicate may now be a normal
confirmed bill. If your UI warns before deleting, say so: "This bill has copies. The
oldest copy will become the main bill."

---

## 10. Suggested UI

### 10.1 After parse-photo (draft review)

When `possible_duplicates` is not empty, show a banner above the review form, using
the first (best) candidate:

```
 ┌───────────────────────────────────────────────────────────────┐
 │  Ana already added this on Oct 3 (Linella, 412.50 MDL).       │
 │  [ Mark as duplicate ]   [ Keep both ]                        │
 └───────────────────────────────────────────────────────────────┘
```

- Text: `` `${created_by_name ?? 'Someone'} already added this on ${date}` ``. For
  `match: 'weak'` soften it: "A bill with the same amount and date exists".
- **Mark as duplicate**: remember `duplicate_of_id = candidate.id` in the review
  form, and send it with the confirm request (§3). The bill is saved as a duplicate
  and is not counted. Another option is to discard the draft.
- **Keep both**: hide the banner and confirm normally. Optionally call
  `dismiss-duplicate` with the candidate (§7) so the pair does not appear in
  suggestions or in either bill's `possible_duplicates` later. For a draft, send the draft id as `{id}`.
- More than one candidate: show a short list and let the user pick the original.
- Never block the confirm button because of a candidate.

### 10.2 Bill detail

- `status === 'duplicate'`: show a badge "Duplicate of Ana's bill on Oct 3" using
  `duplicate_of`, a link to the original and an **Unmark** button (§5).
- Draft or confirmed with `possible_duplicates`: the same banner as above, with
  **Mark as duplicate** (§4; only for a confirmed bill) and **Keep both** (§7).

### 10.3 Clean-up screen

A "Possible duplicates" screen loads `GET .../duplicate-suggestions`. For each pair,
show both bills side by side and two actions:

- **This is a duplicate**: let the user pick which bill is the copy, then call
  `mark-duplicate` on the copy with the other as `duplicate_of_id`.
- **Keep both**: `dismiss-duplicate`.

Remove the pair from the screen after either action. Refetch after marking: marking
a bill can re-point other bills.

### 10.4 Lists

Keep the default list as is. Add an optional "Show duplicates" toggle that sends
`include_duplicates=true` and greys out rows with `status === 'duplicate'`.

---

## 11. API calls

```ts
// api/bills.ts
export const markDuplicate = (hid: string, id: string, duplicateOfId: string) =>
  http.post<BillDetailResponse>(`/households/${hid}/bills/${id}/mark-duplicate`, {
    duplicate_of_id: duplicateOfId,
  }).then((r) => r.data);

export const unmarkDuplicate = (hid: string, id: string) =>
  http.post<BillDetailResponse>(`/households/${hid}/bills/${id}/unmark-duplicate`)
    .then((r) => r.data);

export const dismissDuplicate = (hid: string, id: string, otherBillId: string) =>
  http.post<void>(`/households/${hid}/bills/${id}/dismiss-duplicate`, {
    other_bill_id: otherBillId,
  });

export const duplicateSuggestions = (
  hid: string,
  range: { date_from?: string; date_to?: string } = {},
) =>
  http.get<DuplicateSuggestionsResponse>(
    `/households/${hid}/bills/duplicate-suggestions`,
    { params: range },
  ).then((r) => r.data);

export const listBills = (hid: string, params: { include_duplicates?: boolean } & Record<string, unknown>) =>
  http.get(`/households/${hid}/bills`, { params }).then((r) => r.data);
```

## 12. Checklist

- [ ] Parse-photo review shows a banner for `possible_duplicates`; never blocks.
- [ ] "Mark as duplicate" on a draft sends `duplicate_of_id` with confirm; it does not
      call `mark-duplicate` (a draft gets `409`).
- [ ] "Keep both" confirms normally and calls `dismiss-duplicate`.
- [ ] Bill detail handles `status: "duplicate"` and `duplicate_of`; Unmark button.
- [ ] Treat `possible_duplicates` and `duplicate_of` as optional (absent on draft-list
      rows).
- [ ] Clean-up screen from `duplicate-suggestions`; refetch after any action.
- [ ] List rows read `status` and `duplicate_of_id`; `include_duplicates` is a real
      boolean (`true` / `false`).
- [ ] After deleting an original, refetch screens that showed its copies.
