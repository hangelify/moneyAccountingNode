# Frontend Integration: Editing a Bill

`PUT /households/{hid}/bills/{id}`

## Overview

This guide is for frontend developers who build the **edit bill** screen. The
endpoint edits **any bill**: a draft, a confirmed bill or a bill marked as a
duplicate. In one call it can change the date, total, currency, description,
receipt identity, the market, and the **line items**.

```
 GET .../bills/{id} ─▶ edit screen ─▶ PUT .../bills/{id} ─▶ 200 BillDetailResponse
```

What changed for existing callers:

- The body accepts two new optional fields: `new_market` and `items`.
- The response is now the full `BillDetailResponse` (with `items`, `status`,
  receipt identity and duplicate info) instead of the short bill. It only gained
  fields, so existing code that reads the old ones keeps working.
- Sending only some fields still works: **omitted = keep**.

The call is **all or nothing**. It runs in one database transaction with a row
lock. If it fails (any 4xx), the bill is left exactly as it was.

The call **never changes the bill's status**. Editing a draft keeps it a draft.
To turn a draft into a bill use `POST .../bills/{id}/confirm`
(see [frontend-confirm-bill-integration.md](frontend-confirm-bill-integration.md)).
To mark or unmark a duplicate use `mark-duplicate` / `unmark-duplicate`
(see [frontend-duplicate-bills-integration.md](frontend-duplicate-bills-integration.md)).

Related endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/households/{hid}/bills/{id}` | Load the bill to prefill the form |
| `PUT` | `/households/{hid}/bills/{id}` | **Edit the bill** (this guide) |
| `POST` | `/households/{hid}/bills/{id}/confirm` | Confirm a draft |
| `DELETE` | `/households/{hid}/bills/{id}` | Delete the bill |

Swagger UI with the live schemas is served at `/api` on the backend.

---

## 1. Request

### 1.1 Contract

| | |
|---|---|
| Method | `PUT` |
| Path | `/households/{hid}/bills/{id}` (no global prefix) |
| `hid` | Household uuid. The user must be a member. |
| `id` | Bill uuid (any status) |
| Auth | `Authorization: Bearer <access_token>` |
| Body | `application/json`, `UpdateBillRequest` (below). Every field is optional. |
| Success | `200 OK`, body `BillDetailResponse` |

### 1.2 Types

```ts
// api/types/updateBill.ts
export interface NewMarket {
  name: string;      // 1..255 chars
  city?: string;     // 1..255 chars
  country?: string;  // exactly 2 chars, e.g. "RO"
  address?: string;  // 1..500 chars
}

export interface UpdateBillItem {
  id?: string;              // uuid of an existing line → update it in place; omit for a new line
  sub_category_id?: string; // uuid; omit for an uncategorized line
  raw_name?: string;        // 1..255 chars; see §2.2
  product_count: number;    // integer ≥ 1
  amount: number;           // > 0, max 2 decimals, ≤ 1e12 — paid for the line, after discounts
  product_weight?: number;  // kg, > 0, max 3 decimals, ≤ 9 999 999.999
}

export interface UpdateBillRequest {
  market_id?: string;             // uuid of an existing household market, or
  new_market?: NewMarket;         // find-or-create a market by name (never both)
  bill_date?: string;             // "YYYY-MM-DD"
  currency?: string;              // ISO 4217 code from the backend Currency enum, e.g. "EUR", "RON"
  total_amount?: number;          // > 0, max 2 decimals, ≤ 1e12
  description?: string;
  fiscal_register_id?: string;    // 1..64 chars, cash register id printed on the receipt
  fiscal_receipt_number?: string; // 1..64 chars, receipt number printed on the receipt
  purchase_time?: string;         // "HH:MM", 24-hour
  items?: UpdateBillItem[];       // 1..200 lines; the full new list (§2.2). Omit to keep the lines.
}
```

`UpdateBillItem` is the same shape as the confirm item, so the confirm screen's
item builder can be reused.

### 1.3 Examples

Change only the date (as before, still valid):

```json
{ "bill_date": "2026-10-29" }
```

Full edit: fields, a new market and the lines:

```json
{
  "new_market": { "name": "Lidl", "city": "Bucharest", "country": "RO" },
  "bill_date": "2026-10-28",
  "currency": "EUR",
  "total_amount": 10.19,
  "description": "Weekly groceries",
  "fiscal_register_id": "J403001234",
  "fiscal_receipt_number": "0042",
  "purchase_time": "14:05",
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

The backend rejects **any unknown field** with `400`
(`property X should not exist`), in nested objects too.

Do **not** spread a `GET /bills/{id}` response into the request. Response-only
fields such as `id` (top level), `status`, `market`, `items[].sub_category`,
`items[].unit`, `items[].price_per_unit`, `items[].category_confidence`,
`created_at` or `amount_mismatch` must not be sent. Build the body explicitly
(§3).

---

## 2. What the server does with each field

### 2.1 Bill fields

The rule is **omitted = keep**: only the fields you send are changed.

| Field | Behaviour |
|---|---|
| `bill_date` | Overwrites when sent. `bill_date_inferred` becomes `false`. Plain `YYYY-MM-DD`, a real calendar date. |
| `total_amount` | Overwrites when sent. |
| `currency` | Overwrites when sent. |
| `description` | Overwrites when sent. |
| `fiscal_register_id`, `fiscal_receipt_number`, `purchase_time` | Overwrite when sent. |
| `market_id` | Uses that market. It must belong to this household, else `400`. |
| `new_market` | Looks up a household market by `name` (case-insensitive, exact). Uses it if found, otherwise creates one with the given fields. |
| `market_id` **and** `new_market` | `400` `Send either market_id or new_market, not both`. |
| neither market field | The bill keeps its market. |

> Unlike confirm, leaving out the market **keeps** it. There is currently no way to
> clear a bill's market through this endpoint.

The server does **not** check that the items add up to `total_amount`. It saves
what you send and reports it in `amount_mismatch` (§4).

### 2.2 Items

- **`items` omitted** → the lines are not touched.
- **`items` sent** → it is the **final list of lines** of the bill:

| Case | What happens |
|---|---|
| Item with `id` of a line of this bill | That line is updated in place. |
| Item without `id` | A new line is created. |
| Existing line whose `id` is not in `items` | **The line is deleted.** |
| `id` that is not a line of this bill | `400` `Item with ID … is not a line of this bill` |
| Same `id` twice | `400` `Duplicate item id … in items` |
| Empty array `[]` | `400` (a bill needs at least one line) |

Always send back the `id` of every line you keep. Without it the line is deleted
and re-created, and it loses what the AI read (unit, unit price, confidence,
reasoning).

**`raw_name`** (product name as printed on the receipt):

- Sent → saved.
- Omitted on an existing line → the line keeps its name.
- Omitted on a new line → the sub-category name is used.
- **Required on a new line without `sub_category_id`** (else `400`).

**`sub_category_id`**:

- Omit it for an uncategorized line. This is allowed.
- It must be a sub-category of this household, else `400`
  `SubCategory with ID … not found or belongs to another user`.

**AI data on kept lines** (read-only, returned in the response):

- `unit` is always kept.
- `category_confidence` and `category_reasoning` are cleared when the line's
  sub-category changes.
- `price_per_unit` is cleared when `amount` or `product_weight` changes, or
  `product_count` on a line without a weight.

**`product_weight`**: omitted = the line has no weight (`null`), even if it had
one. Always send it back for weighed lines.

---

## 3. Building the request from the edit form

### 3.1 Prefill from `GET /households/{hid}/bills/{id}`

| Response field | Request field |
|---|---|
| `items[].id` | `items[].id` |
| `items[].sub_category?.id` | `items[].sub_category_id` (omit when `null`) |
| `items[].raw_name` | `items[].raw_name` (send only if edited) |
| `items[].product_count` | `items[].product_count` |
| `items[].amount` | `items[].amount` |
| `items[].product_weight` | `items[].product_weight` (omit when absent) |
| `market?.id` | `market_id` |
| `bill_date`, `currency`, `total_amount`, `description` | same names |
| `fiscal_register_id`, `fiscal_receipt_number`, `purchase_time` | same names (omit when `null`) |

### 3.2 Request builder

Send only what the user changed. That keeps the request small and avoids
overwriting a field another household member edited in the meantime.

```ts
// features/bills/edit/model.ts
export interface EditLine {
  key: string;              // React key; = id for existing lines, random for new ones
  id?: string;              // existing line id; undefined for user-added lines
  rawName: string;
  rawNameEdited: boolean;
  subCategoryId: string | null;
  productCount: number;
  amount: number;
  weightKg: number | null;
}

export interface EditForm {
  market: { kind: 'existing'; id: string } | { kind: 'new'; market: NewMarket } | null;
  billDate: string;
  currency: string | null;
  totalAmount: number;
  description: string;
  fiscalRegisterId: string;
  fiscalReceiptNumber: string;
  purchaseTime: string;     // "HH:MM" or ""
  lines: EditLine[];
}

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

function toItem(l: EditLine): UpdateBillItem {
  const item: UpdateBillItem = {
    product_count: Math.max(1, Math.round(l.productCount)),
    amount: round(l.amount, 2),
  };
  if (l.id) item.id = l.id;
  if (l.subCategoryId) item.sub_category_id = l.subCategoryId;
  if (l.rawNameEdited || (!l.id && !l.subCategoryId)) item.raw_name = l.rawName.trim();
  if (l.weightKg != null) item.product_weight = round(l.weightKg, 3);
  return item;
}

/** Only the fields that differ from the loaded form. */
export function toUpdateRequest(initial: EditForm, f: EditForm): UpdateBillRequest {
  const body: UpdateBillRequest = {};
  const changed = <K extends keyof EditForm>(k: K) =>
    JSON.stringify(initial[k]) !== JSON.stringify(f[k]);

  if (changed('market')) {
    if (f.market?.kind === 'existing') body.market_id = f.market.id;
    if (f.market?.kind === 'new') body.new_market = f.market.market;
    // f.market === null: clearing the market is not supported (§2.1)
  }
  if (changed('billDate')) body.bill_date = f.billDate;
  if (changed('currency') && f.currency) body.currency = f.currency;
  if (changed('totalAmount')) body.total_amount = round(f.totalAmount, 2);
  if (changed('description')) body.description = f.description.trim();
  if (changed('fiscalRegisterId') && f.fiscalRegisterId.trim())
    body.fiscal_register_id = f.fiscalRegisterId.trim();
  if (changed('fiscalReceiptNumber') && f.fiscalReceiptNumber.trim())
    body.fiscal_receipt_number = f.fiscalReceiptNumber.trim();
  if (changed('purchaseTime') && f.purchaseTime) body.purchase_time = f.purchaseTime;
  // Lines go as a whole list: send them when any line changed, was added or removed.
  if (changed('lines')) body.items = f.lines.map(toItem);
  return body;
}
```

### 3.3 API call

```ts
// api/bills.ts
export async function updateBill(
  hid: string,
  billId: string,
  body: UpdateBillRequest,
): Promise<BillDetailResponse> {
  const { data } = await http.put<BillDetailResponse>(
    `/households/${hid}/bills/${billId}`,
    body,
  );
  return data;
}
```

---

## 4. Response

`200 OK` with the saved bill, the same shape as `GET /bills/{id}`:

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

export interface PossibleDuplicate {
  id: string;
  bill_date: string;
  total_amount: number;
  currency: string | null;
  market_name: string | null;
  created_by_name: string | null;
  match?: 'fiscal' | 'strong' | 'weak';
}

export interface BillDetailResponse {
  id: string;
  bill_date: string;                  // YYYY-MM-DD
  currency?: string;
  total_amount: number;
  amount_mismatch: boolean;           // items don't add up to total_amount
  description?: string;
  market?: { id: string; name: string; city?: string };
  created_at: string;                 // ISO timestamp
  household_currency?: string;
  household_amount?: number | null;   // total in the household currency
  exchange_rate?: object | null;      // rate used for household_amount
  status: 'draft' | 'confirmed' | 'duplicate'; // unchanged by this call
  market_name_raw?: string;
  bill_date_inferred: boolean;
  fiscal_register_id: string | null;
  fiscal_receipt_number: string | null;
  purchase_time: string | null;       // HH:MM
  items: BillItemResponse[];          // in the order you sent them
  possible_duplicates: PossibleDuplicate[]; // look-alikes after the edit; [] for a duplicate
  duplicate_of: PossibleDuplicate | null;   // the original, when status is "duplicate"
}
```

Optional fields are **left out** of the JSON when empty, except the ones typed
`| null` above.

After success:

- Replace the bill in local state with the response (no extra `GET` needed).
- Invalidate the bills list, dashboard and spending-breakdown queries (date,
  total, currency and categories can all change).
- If `possible_duplicates` is non-empty, the edit made the bill look like another
  one (for example the date or total now match). Show the same hint as after
  confirm.

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
| `400` | Validation failed (`message` is an array), unknown field, `id` in path not a uuid | Show field errors; fix the request builder for unknown fields |
| `400` | `Send either market_id or new_market, not both` | Request builder bug: send one |
| `400` | `Market with ID … not found or belongs to another user` | Market was deleted; reload markets and let the user pick again |
| `400` | `SubCategory with ID … not found or belongs to another user` | Sub-category was deleted; reload categories, highlight the line |
| `400` | `Item with ID … is not a line of this bill` / `Duplicate item id …` | Form state is stale; reload the bill (`GET /bills/{id}`) |
| `401` | Token missing or expired | Refresh token and retry, or log in |
| `403` | Not a member of household `hid` | Go to household picker |
| `404` | `Bill with ID … not found`: deleted or in another household | Tell the user the bill no longer exists; remove it locally |

Because a failed update changes nothing, it is safe to let the user retry any
`400` after fixing the form.

**Concurrent edits.** Two edits of the same bill run one after the other; the
last one wins for the fields it sends. Sending only changed fields (§3.2) keeps
the other person's edits to other fields. `items`, when sent, always replaces the
whole list.

---

## 6. UX checklist

- [ ] The save button is disabled while the request runs.
- [ ] The form is prefilled from `GET /bills/{id}` and keeps every line `id`.
- [ ] Only changed fields are sent; `items` is sent as the full list when any line changed.
- [ ] Removing a line in the UI just drops it from `items`; there is no separate delete call.
- [ ] The sum of the lines vs. `total_amount` is shown live.
- [ ] User-added lines need a name when they have no sub-category.
- [ ] Market picker sends `market_id` for an existing market or `new_market` for a typed name, never both.
- [ ] Draft bills can be edited here, but the "Confirm" action still calls `POST .../confirm`.
- [ ] Request builder sends only the fields in §1.2.
