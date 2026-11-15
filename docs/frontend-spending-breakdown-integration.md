# Frontend Integration: Spending Breakdown (Sunburst)

`GET /households/{hid}/bills/dashboard/spending-breakdown`

## Overview

This guide is for frontend developers who draw the **spending sunburst** on the
dashboard: categories on the inner ring, sub-categories on the outer ring. The
endpoint returns the household's spending as a category → sub-category tree for
one period:

- `week` (ISO week, Monday to Sunday), `month`, `quarter`, `year`,
- `5y` (the last 60 full months, ending with the current month),
- `custom` (any `from`..`to`, both days included, up to 10 years).

It is separate from `GET /bills/dashboard` so the chart can refetch on its own when
the user switches period, without reloading the rest of the dashboard.

```
 period picker ─▶ GET .../bills/dashboard/spending-breakdown?period=month&anchor=2026-10-31
                                   │
                                   ▼
                  by_currency[0..n] ─▶ one sunburst per currency
                    categories (inner ring) ─▶ sub_categories (outer ring)
```

Related endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/households/{hid}/bills/dashboard` | Period totals, bill list, category stats |
| `GET` | `/households/{hid}/bills/dashboard/spending-breakdown` | **Category → sub-category tree** (this guide) |
| `GET` | `/households/{hid}/bills?date_from=&date_to=` | Bills of a range (drill-down) |

Swagger UI with the live schemas is served at `/api` on the backend.

---

## 1. Request

### 1.1 Contract

| | |
|---|---|
| Method | `GET` |
| Path | `/households/{hid}/bills/dashboard/spending-breakdown` (no global prefix) |
| `hid` | Household uuid. The user must be a member (any role). |
| Auth | `Authorization: Bearer <access_token>` |
| Success | `200 OK`, JSON body (§2) |

Query parameters:

| Name | Required | Format | Meaning |
|---|---|---|---|
| `period` | yes | `week` \| `month` \| `quarter` \| `year` \| `5y` \| `custom` | Which range |
| `anchor` | no | `YYYY-MM-DD` | Any day inside the period. Defaults to today **in UTC**. Ignored for `custom`. |
| `from` | with `custom` | `YYYY-MM-DD` | First day, included |
| `to` | with `custom` | `YYYY-MM-DD` | Last day, **included**. Not before `from`, and less than 10 years after it. |
| `currency` | no | `MDL`, `EUR`, `USD`, … | Only bills in this currency |

Unknown parameters are rejected with `400`.

**Always send `anchor` with the user's local date.** The default is today in UTC,
so around midnight a user east or west of UTC would otherwise get the previous or
next day's week/month. Build it from local date parts, not from `toISOString()`:

```ts
function localIsoDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
```

### 1.2 Which days a period covers

For `anchor=2026-10-31` (a Saturday). `end` is **exclusive**: the range is
`start <= bill_date < end`.

| `period` | `range.start` | `range.end` | Covers |
|---|---|---|---|
| `week` | `2026-10-26` | `2026-11-02` | Mon 26 Oct – Sun 1 Nov |
| `month` | `2026-10-01` | `2026-11-01` | October |
| `quarter` | `2026-10-01` | `2027-01-01` | Q4 |
| `year` | `2026-01-01` | `2027-01-01` | 2026 |
| `5y` | `2021-11-01` | `2026-11-01` | Nov 2021 – Oct 2026 (60 months) |
| `custom` `from=2026-03-05&to=2026-03-20` | `2026-03-05` | `2026-03-21` | 5–20 March |

To step to the previous/next period, send an `anchor` inside it (for example
`range.start` minus one day for "previous"). The response's `range` is the source
of truth for labels; don't recompute it on the client.

### 1.3 Example

```http
GET /households/5f0c1e2a-8b7d-4c3e-9a1b-2c3d4e5f6a7b/bills/dashboard/spending-breakdown?period=month&anchor=2026-10-31 HTTP/1.1
Authorization: Bearer eyJhbGciOi...
```

### 1.4 Client function

```ts
// api/dashboard.ts
export type SpendingPeriod = 'week' | 'month' | 'quarter' | 'year' | '5y' | 'custom';

export interface SpendingBreakdownParams {
  period: SpendingPeriod;
  anchor?: string; // YYYY-MM-DD, local date
  from?: string;   // custom only
  to?: string;     // custom only, inclusive
  currency?: string;
}

export async function getSpendingBreakdown(
  hid: string,
  params: SpendingBreakdownParams,
): Promise<SpendingBreakdown> {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][],
  );
  const res = await apiFetch(
    `/households/${hid}/bills/dashboard/spending-breakdown?${qs}`,
  );
  if (!res.ok) throw await toApiError(res); // see §3
  return res.json();
}
```

---

## 2. Response

### 2.1 Types

```ts
export interface SpendingBreakdown {
  range: { period: SpendingPeriod; start: string; end: string }; // end exclusive
  by_currency: SpendingCurrency[];
}

export interface SpendingCurrency {
  currency: string | null; // null = bills without a currency
  total: number;           // sum of all categories below
  lines: number;           // receipt lines counted
  categories: SpendingCategory[];
}

export interface SpendingCategory {
  id: string | null;       // null only for the Uncategorized bucket
  name: string;            // "Uncategorized" when id is null
  total: number;
  share: number;           // % of the currency total, 0–100, 2 decimals
  archived: boolean;       // the category was deleted
  sub_categories: SpendingSubCategory[]; // [] for Uncategorized
}

export interface SpendingSubCategory {
  id: string;
  name: string;
  total: number;
  share_of_category: number; // % of the parent category, 0–100, 2 decimals
  lines: number;
  archived: boolean;         // the sub-category or its category was deleted
}
```

### 2.2 Example

```json
{
  "range": { "period": "month", "start": "2026-10-01", "end": "2026-11-01" },
  "by_currency": [
    {
      "currency": "MDL",
      "total": 1250.4,
      "lines": 58,
      "categories": [
        {
          "id": "0d6c…", "name": "Food", "total": 910.4, "share": 72.81, "archived": false,
          "sub_categories": [
            { "id": "4a1e…", "name": "Dairy", "total": 410, "share_of_category": 45.03, "lines": 21, "archived": false },
            { "id": "9b77…", "name": "Bread", "total": 500.4, "share_of_category": 54.97, "lines": 25, "archived": false }
          ]
        },
        {
          "id": null, "name": "Uncategorized", "total": 340, "share": 27.19, "archived": false,
          "sub_categories": []
        }
      ]
    }
  ]
}
```

### 2.3 Rules to rely on

- **Currencies are never summed.** Each currency is its own tree. Draw one
  sunburst per entry, or a currency switcher; never add totals across entries.
  `by_currency` is sorted by currency code, with `currency: null` (bills saved
  without a currency) last.
- **Empty range:** `by_currency` is `[]`. Show an empty state, not a broken chart.
- **Sorting:** categories by `total`, largest first, with **Uncategorized always
  last**. Sub-categories by `total`, largest first. Equal totals sort by name.
  Draw in the given order and the rings stay stable between refetches.
- **Uncategorized** collects lines that have no sub-category. It has `id: null`
  and no sub-categories. Its `name` is the constant `"Uncategorized"`: match on
  `id === null` and show your own translated label. On the outer ring, draw it as
  one segment spanning its inner slice (or leave the outer ring empty there).
- **Archived** categories and sub-categories were deleted after the spending
  happened. They stay in the tree so history adds up; render them muted (for
  example grey, with an "archived" hint in the tooltip). A sub-category is
  `archived` when it or its category was deleted.
- **Totals are sums of receipt lines, not of bill totals.** A bill's total and the
  sum of its lines can differ by a few cents (rounding on the receipt), so these
  numbers may not match `GET /bills/dashboard` period totals to the cent. Don't
  show them side by side as if they must agree.
- **Shares** are rounded to 2 decimals, so they may add up to 99.99 or 100.01. Use
  `total` for the arc angles and `share` only for labels.
- **Only confirmed bills count.** Drafts and deleted bills are excluded, so
  confirming or deleting a bill changes this chart (§4).

---

## 3. Errors

All errors use the standard NestJS body:

```ts
interface ApiError {
  statusCode: number;
  message: string | string[]; // validation errors: one string per problem
  error?: string;             // e.g. "Bad Request"; absent on 401 and 403
}
```

| Status | Body example | When | What to do |
|---|---|---|---|
| `400` | `{"statusCode":400,"message":["from should not be null or undefined","from must be a valid calendar date in YYYY-MM-DD format","to should not be null or undefined","to must be a valid calendar date in YYYY-MM-DD format"],"error":"Bad Request"}` | `period=custom` without `from`/`to` | Bug in the caller |
| `400` | `{"statusCode":400,"message":["to must not be before from"],"error":"Bad Request"}` | `from` after `to` | Validate the picker before sending; show "End date is before start date" |
| `400` | `{"statusCode":400,"message":["to must be at most 10 years after from"],"error":"Bad Request"}` | Custom range of 10 years or more | Limit the picker; show "Choose at most 10 years" |
| `400` | `{"statusCode":400,"message":["anchor must be a valid calendar date in YYYY-MM-DD format"],"error":"Bad Request"}` | Malformed date (`2026-02-30`, a time, a slash format), unknown `period` or `currency`, or an unknown parameter | Bug in the caller |
| `401` | `{"statusCode":401,"message":"Unauthorized"}` | Token missing or expired | Refresh the token and retry once, else log in |
| `403` | `{"statusCode":403,"message":"Forbidden"}` | Not a member of household `hid` | Go to the household picker |
| `500` | `{"statusCode":500,"message":"Internal server error"}` | Server failure | Keep the previous chart, show a retry |

The custom range limit: `to` must be **before** the same day 10 years after
`from`. `2016-11-01`..`2026-10-31` is accepted; `2016-11-01`..`2026-11-01` is not.

---

## 4. Caching and refresh

Key the query by everything that changes the answer:

```ts
const breakdown = useQuery({
  queryKey: ['households', hid, 'dashboard', 'spending-breakdown', params],
  queryFn: () => getSpendingBreakdown(hid, params),
  placeholderData: keepPreviousData, // keep the old chart while switching period
});
```

Because the key starts with `['households', hid, 'dashboard']`, the invalidations
you already run after creating, confirming, editing or deleting a bill also refresh
this chart. Also invalidate it after renaming or deleting a category or
sub-category, since names and `archived` come from them.

Response times: a week or month answers in a few milliseconds; `5y` for a large
household can take a few hundred. Show a loading state on the chart only, and
debounce custom-range pickers.

---

## 5. UX checklist

- [ ] `anchor` is the user's **local** date, built from date parts (not `toISOString()`).
- [ ] Labels and previous/next navigation come from `range` (`end` is exclusive).
- [ ] One sunburst (or a switcher) per currency; totals are never added across currencies.
- [ ] Empty `by_currency` shows an empty state.
- [ ] Uncategorized is detected by `id === null` and its label is translated.
- [ ] Archived categories and sub-categories are visible but muted.
- [ ] Arc sizes use `total`; `share` is only for labels.
- [ ] The custom picker blocks `from > to` and ranges of 10 years or more.
- [ ] The chart refreshes after bill and category changes.

---

## 6. Testing against a local backend

```bash
curl -s "http://localhost:3000/households/$HID/bills/dashboard/spending-breakdown?period=month&anchor=$(date +%F)" \
  -H "Authorization: Bearer $TOKEN" | jq
```

```bash
curl -s "http://localhost:3000/households/$HID/bills/dashboard/spending-breakdown?period=custom&from=2026-03-02&to=2026-03-01" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Expected: the first returns the month's tree; the second answers `400` with
`"to must not be before from"`.
