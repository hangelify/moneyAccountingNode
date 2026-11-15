# Frontend Integration: Confirming a Draft Bill

`POST /households/{hid}/bills/{id}/confirm`

## Overview

This guide is for frontend developers who build the **review and confirm** screen
for draft bills. A draft is created by `POST /households/{hid}/bills/parse-photo`
(see [frontend-parse-photo-integration.md](frontend-parse-photo-integration.md)).
The user reviews and edits it, then confirms it. Confirming applies the user's edits
and turns the draft into a permanent bill (`status: "confirmed"`).

```
 parse-photo ─▶ draft ─▶ review screen ─▶ POST .../bills/{id}/confirm ─▶ confirmed bill
                  ▲                                   │
   GET .../drafts ┘ (resume later)                    └─ 200 BillDetailResponse
```

The confirm call is **all or nothing**. It runs in one database transaction. If it
fails (any 4xx), the draft is left exactly as it was, so the user can fix the form
and try again.

Related endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/households/{hid}/bills/drafts?page=&limit=` | List open drafts with their items |
| `GET` | `/households/{hid}/bills/drafts/{id}/image` | Short-lived URL of the receipt photo |
| `GET` | `/households/{hid}/bills/{id}` | Get one bill (draft or confirmed) |
| `POST` | `/households/{hid}/bills/{id}/confirm` | **Confirm the draft** (this guide) |
| `DELETE` | `/households/{hid}/bills/{id}` | Discard the draft |

Swagger UI with the live schemas is served at `/api` on the backend.

---

## 1. Request

### 1.1 Contract

| | |
|---|---|
| Method | `POST` |
| Path | `/households/{hid}/bills/{id}/confirm` (no global prefix) |
| `hid` | Household uuid. The user must be a member. |
| `id` | Draft bill uuid (`draft_id` from parse-photo, or `id` from the drafts list) |
| Auth | `Authorization: Bearer <access_token>` |
| Body | `application/json`, `ConfirmBillRequest` (below) |
| Success | `200 OK` (not 201), body `BillDetailResponse` |

### 1.2 Types

```ts
// api/types/confirmBill.ts
export interface NewMarket {
  name: string;      // 1..255 chars
  city?: string;     // 1..255 chars
  country?: string;  // exactly 2 chars, e.g. "RO"
  address?: string;  // 1..500 chars
}

export interface ConfirmBillItem {
  id?: string;              // uuid of a draft line → update it in place; omit for a new line
  sub_category_id?: string; // uuid; omit to confirm the line without a sub-category
  raw_name?: string;        // 1..255 chars; see the rules in §2.2
  product_count: number;    // integer ≥ 1
  amount: number;           // > 0, max 2 decimals, ≤ 1e12 — paid for the line, after discounts
  product_weight?: number;  // kg, > 0, max 3 decimals, ≤ 9 999 999.999
}

export interface ConfirmBillRequest {
  market_id?: string;       // uuid of an existing household market, or
  new_market?: NewMarket;   // find-or-create a market by name
  bill_date: string;        // "YYYY-MM-DD", required
  currency?: string;        // ISO 4217 code from the backend Currency enum, e.g. "EUR", "RON"
  total_amount: number;     // > 0, max 2 decimals, ≤ 1e12, required
  description?: string;
  items: ConfirmBillItem[]; // 1..200 lines
}
```

### 1.3 Example

```json
{
  "market_id": "0d6b2a7e-6b3f-4b51-9a3c-2f1f2d9c1a11",
  "bill_date": "2026-10-28",
  "currency": "EUR",
  "total_amount": 10.19,
  "description": "Weekly groceries",
  "items": [
    {
      "id": "e3c1b8a4-1f0a-4c7e-8f3b-3d2b1a0c9e77",
      "sub_category_id": "9a1c4f20-5b6d-4e8f-a1b2-c3d4e5f6a7b8",
      "product_count": 1,
      "amount": 2.49
    },
    {
      "id": "7f2e9d10-3c4b-4a5e-9f8d-1e2f3a4b5c6d",
      "sub_category_id": "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
      "product_count": 1,
      "amount": 4.71,
      "product_weight": 0.942
    },
    {
      "raw_name": "Plastic bag",
      "product_count": 1,
      "amount": 2.99
    }
  ]
}
```

### 1.4 Strict body: send only known fields

The backend validation rejects **any unknown field** with `400`
(`property X should not exist`). This applies to nested objects too.

Do **not** spread a parsed or stored item into the request. Fields like `name`,
`unit`, `quantity`, `weight_kg`, `final_price`, `price_per_unit`,
`category_confidence`, `category_reasoning` or `sub_category` must not be sent.
Build each item explicitly (see §3).

---

## 2. What the server does with each field

### 2.1 Bill fields

| Field | Behaviour |
|---|---|
| `bill_date` | Always overwrites the draft date. `bill_date_inferred` becomes `false`. Must be a real calendar date in plain `YYYY-MM-DD` (no time, no offset). |
| `total_amount` | Always overwrites the draft total. |
| `currency` | Overwrites when sent. **Omitted = keep the draft's currency.** |
| `description` | Overwrites when sent. **Omitted = keep the draft's description.** |
| `market_id` | Uses that market. It must belong to this household, else `400`. Wins over `new_market` when both are sent. |
| `new_market` | Looks up a household market by `name` (case-insensitive, exact match). Uses it if found; otherwise creates a new market with the given fields. |
| neither | **The bill is saved with no market.** A market the draft had is cleared. |

> ⚠️ The market is the one field where "omitted" does **not** mean "keep". If the user
> picked a market, always send `market_id` or `new_market`.

The server does **not** check that the items add up to `total_amount`. It saves
what you send and reports the result in `amount_mismatch` (§4). Show the
difference on the review screen before the user confirms.

### 2.2 Items

The `items` array is the **final list of lines** of the bill.

| Case | What happens |
|---|---|
| Item with `id` of a draft line | That line is updated in place. |
| Item without `id` | A new line is created. |
| Draft line whose `id` is not in `items` | **The line is deleted.** |
| `id` that is not a line of this bill | `400` `Item with ID … is not a line of this bill` |
| Same `id` twice | `400` `Duplicate item id … in items` |

Always send `id` back for lines that came from the draft. Without it, the line is
deleted and re-created, and it loses what the AI read (unit, unit price,
confidence, reasoning).

**`raw_name`** (the product name as printed on the receipt):

- Sent → saved.
- Omitted on a draft line → the draft line keeps its name.
- Omitted on a new line → the sub-category name is used.
- **Required on a new line without `sub_category_id`** (else `400`).

**`sub_category_id`**:

- Omit it (or leave it out when the user did not pick one) to confirm the line as
  *uncategorized*. This is allowed.
- It must be a sub-category of this household, else `400`
  `SubCategory with ID … not found or belongs to another user`.
- Two lines may have the same sub-category. They stay separate lines.

**AI data on kept lines** (read-only, shown in the response):

- `unit` is always kept.
- `category_confidence` and `category_reasoning` are cleared when the user changes
  the line's sub-category (they described the old choice).
- `price_per_unit` is cleared when the user changes `amount` or `product_weight`,
  or `product_count` on a line without a weight.

**`product_weight`**: omitted = the line has no weight (`null`), even if the draft
line had one. Always send it back for weighed lines.

---

## 3. Building the request from the review form

### 3.1 From the parse-photo response

| Parse-photo field | Confirm field | Notes |
|---|---|---|
| `draft_id` | path `{id}` | |
| `items[].id` | `items[].id` | Keep it |
| `items[].sub_category?.id` | `items[].sub_category_id` | Omit when `null` |
| `items[].name` | `items[].raw_name` | Send only if the user edited it |
| `items[].quantity` | `items[].product_count` | `quantity ?? 1`; integer ≥ 1 |
| `items[].final_price` | `items[].amount` | Round to 2 decimals |
| `items[].weight_kg` | `items[].product_weight` | Omit when `null`; round to 3 decimals |
| `market_name` | `market_id` or `new_market.name` | Prefer an existing market the user picked |
| `bill_date` | `bill_date` | Required; default to today when `null` |
| `currency` | `currency` | |
| `total_amount` | `total_amount` | Required; the user must fill it when `null` |

### 3.2 From the drafts list / `GET /bills/{id}`

These return the stored bill shape (`BillDetailResponse`, §4). Mapping:

| Stored field | Confirm field |
|---|---|
| `items[].id` | `items[].id` |
| `items[].sub_category?.id` | `items[].sub_category_id` |
| `items[].raw_name` | `items[].raw_name` (only if edited) |
| `items[].product_count` | `items[].product_count` |
| `items[].amount` | `items[].amount` |
| `items[].product_weight` | `items[].product_weight` |
| `market?.id` | `market_id` |
| `market_name_raw` | prefill for `new_market.name` when there is no `market` |
| `bill_date`, `currency`, `total_amount`, `description` | same names |

If `bill_date_inferred` is `true`, no date was read from the receipt and
`bill_date` is the upload day. Ask the user to check it.

### 3.3 One view model for both sources

```ts
// features/bills/review/model.ts
export interface ReviewLine {
  key: string;              // React key; = id for draft lines, random for new ones
  id?: string;              // draft line id; undefined for user-added lines
  rawName: string;
  rawNameEdited: boolean;
  subCategoryId: string | null;
  productCount: number;
  amount: number;
  weightKg: number | null;
}

export interface ReviewForm {
  draftId: string;
  market: { kind: 'existing'; id: string } | { kind: 'new'; market: NewMarket } | null;
  billDate: string;         // YYYY-MM-DD
  currency: string | null;
  totalAmount: number | null;
  description: string;
  lines: ReviewLine[];
}

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

export function toConfirmRequest(f: ReviewForm): ConfirmBillRequest {
  if (f.totalAmount == null) throw new Error('total_amount is required');
  const body: ConfirmBillRequest = {
    bill_date: f.billDate,
    total_amount: round(f.totalAmount, 2),
    items: f.lines.map((l) => {
      const item: ConfirmBillItem = {
        product_count: Math.max(1, Math.round(l.productCount)),
        amount: round(l.amount, 2),
      };
      if (l.id) item.id = l.id;
      if (l.subCategoryId) item.sub_category_id = l.subCategoryId;
      // New uncategorized lines must carry a name; edited names are always sent.
      if (l.rawNameEdited || (!l.id && !l.subCategoryId)) item.raw_name = l.rawName.trim();
      if (l.weightKg != null) item.product_weight = round(l.weightKg, 3);
      return item;
    }),
  };
  if (f.market?.kind === 'existing') body.market_id = f.market.id;
  if (f.market?.kind === 'new') body.new_market = f.market.market;
  if (f.currency) body.currency = f.currency;
  if (f.description.trim()) body.description = f.description.trim();
  return body;
}
```

### 3.4 API call

```ts
// api/bills.ts
export async function confirmBill(
  hid: string,
  draftId: string,
  body: ConfirmBillRequest,
): Promise<BillDetailResponse> {
  const { data } = await http.post<BillDetailResponse>(
    `/households/${hid}/bills/${draftId}/confirm`,
    body,
  );
  return data;
}
```

---

## 4. Response

`200 OK` with the confirmed bill:

```ts
// api/types/bill.ts
export interface SubCategoryRef {
  id: string;
  name: string;
  category_name: string;
}

export interface BillItemResponse {
  id: string;                         // line id (stable for kept lines)
  sub_category: SubCategoryRef | null;
  product_count: number;
  amount: number;
  product_weight?: number;            // kg
  raw_name: string;
  unit?: 'kg' | 'g' | 'l' | 'ml' | 'piece';
  price_per_unit?: number;
  category_confidence?: number;       // 0..1
  category_reasoning?: string;
}

export interface BillDetailResponse {
  id: string;
  bill_date: string;                  // YYYY-MM-DD
  currency?: string;
  total_amount: number;
  amount_mismatch: boolean;           // items don't add up to the total (see below)
  description?: string;
  market?: { id: string; name: string; city?: string };
  created_at: string;                 // ISO timestamp
  status: 'draft' | 'confirmed';      // "confirmed" after this call
  market_name_raw?: string;           // store name as read by the AI
  bill_date_inferred: boolean;        // false after confirm
  items: BillItemResponse[];          // in the order you sent them
}
```

Optional fields are **left out** of the JSON when empty (not `null`), except
`items[].sub_category`, which is `null` for uncategorized lines.

`amount_mismatch` is `true` when `|total_amount − Σ items.amount|` is greater than
the per-item tolerance (default 0.01, backend env `BILL_ITEM_TOLERANCE`) times the
number of lines. Use it to badge the bill in lists; the confirm still succeeds.

After success:

- Remove the draft from the local drafts list / pending badge.
- Invalidate the bills list and the dashboard queries.
- Navigate to the bill detail, using the response (no extra `GET` needed).

---

## 5. Errors

All errors use the standard NestJS body:

```ts
interface ApiError {
  statusCode: number;
  message: string | string[]; // array of strings for validation errors
  error: string;              // e.g. "Bad Request"
}
```

| Status | When | What to do |
|---|---|---|
| `400` | Validation failed (`message` is an array), unknown field sent, `id` in path not a uuid | Show field errors; fix the request builder for unknown fields |
| `400` | `Market with ID … not found or belongs to another user` | Market was deleted; reload markets and let the user pick again |
| `400` | `SubCategory with ID … not found or belongs to another user` | Sub-category was deleted; reload categories, highlight the line |
| `400` | `Item with ID … is not a line of this bill` / `Duplicate item id …` | Form state is stale; reload the draft (`GET /bills/{id}`) |
| `401` | Token missing or expired | Refresh token and retry, or log in |
| `403` | Not a member of household `hid` (or `hid` malformed) | Go to household picker |
| `404` | Draft not found: deleted, expired (30 days) or in another household | Tell the user the draft no longer exists; remove it locally |
| `409` | `Bill with ID … is already confirmed` | See below |

**`409` handling.** Another household member, another tab, or your own earlier
request (e.g. a retry after a network timeout) already confirmed the draft. When
two confirms run at the same time, exactly one wins; the other gets `409`. Don't
show it as a failure: fetch `GET /households/{hid}/bills/{id}` and show the bill,
with a note like "This receipt was already confirmed" if the user's edits may not
be the ones saved.

Because a failed confirm changes nothing, it is safe to let the user retry any
`400` after fixing the form.

---

## 6. UX checklist

- [ ] The confirm button is disabled while the request runs (prevents a `409` on yourself).
- [ ] `bill_date` and `total_amount` are required in the form; date defaults to today when missing and is highlighted when `bill_date_inferred` is true.
- [ ] The sum of the lines vs. `total_amount` is shown live before confirm.
- [ ] Uncategorized and low-confidence (`category_confidence` low) lines are highlighted, but confirming them is allowed.
- [ ] User-added lines need a name when they have no sub-category.
- [ ] Deleting a line in the UI just drops it from `items`; there is no separate delete call.
- [ ] Market picker sends `market_id` for existing markets, `new_market` for typed names, and the user is told that "no market" clears it.
- [ ] Request builder sends only the fields in §1.2.
- [ ] `409` leads to the saved bill, not an error screen.
- [ ] After success, the drafts list, bills list and dashboard are refreshed.

---

## 7. Testing against a local backend

```bash
curl -X POST "http://localhost:3000/households/$HID/bills/$DRAFT_ID/confirm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bill_date":"2026-10-28","total_amount":10.19,"currency":"EUR","new_market":{"name":"Lidl"},"items":[{"raw_name":"Bread","product_count":1,"amount":10.19}]}'
```

Note that this example drops every draft line (none has an `id`) and adds one new
line. Useful cases to try: the same request twice (`409`), an extra field such as
`"name"` on an item (`400`), a line `id` from another draft (`400`), a random
draft id (`404`), and items that don't add up to the total (`200` with
`amount_mismatch: true`).
