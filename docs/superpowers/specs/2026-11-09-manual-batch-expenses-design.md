# Manual expenses in a batch — design

Date: 2026-11-09
Status: approved design, not implemented
Linear: HAN-48 (epic HAN-46), after HAN-65

## Goal

Cash and small purchases never reach the app today: a bill is created from a
photo, and a photo for a 1–2 € purchase takes too long. The quick-entry form
(HAN-50) lets a user type several expenses on one screen and save them with
one button.

After this change the API **saves a batch of manual expenses in one call**.
Each row becomes its own confirmed bill with one line, so the dashboard, the
spending breakdown, future limits (HAN-25), moves between budgets (HAN-23)
and shared bills (HAN-30) see it without changes.

### Decisions taken

- **One row = one bill** (`source = manual`, `status = confirmed`) with one
  line. No separate `expenses` table. Payment method and accounts are not
  stored (owner, 2026-11-08).
- **`bills.source` lands first, in its own PR (HAN-65).** HAN-48 builds on it.
- **Idempotency key lives on `bills`**: `client_batch_id` + `client_batch_index`
  with a unique index. No batch table, no generic `Idempotency-Key` mechanism.
- **A replay returns what was created**, as it is now (edited or deleted
  bills included). The body of a replay is not compared.
- **The note goes to the line's `raw_name`**, which the breakdown and the bill
  card show. `bills.description` stays empty.
- **`bill_date` may be at most tomorrow** (Chisinau day + 1, a margin for time
  zones). No lower bound.
- **No duplicate search on create.** Manual bills are ordinary confirmed
  bills, so the photo flow finds them as candidates later.
- **Recently used categories** (`GET categories/recent`) ship in this ticket.
- **Out of scope:** payment method, hidden categories (HAN-59 does not exist
  yet), matching with bank imports (HAN-41 owns it), refunds and negative
  amounts.

## 1. Prerequisite: `bills.source` (HAN-65, separate PR)

- Native enum `bill_source`: `photo | manual | bank`; column
  `bills.source NOT NULL`.
- Migration: bills with `ai_request_id` → `photo`, the rest → `manual`.
- `POST /bills` writes `manual`; parse-photo and the photo batch write `photo`.
- `source` in `BillResponseDto` and `BillDetailResponseDto`.

## 2. Data model (HAN-48)

New columns on `bills`:

| column | type | note |
|---|---|---|
| `client_batch_id` | `uuid NULL` | the form's key for one submit |
| `client_batch_index` | `smallint NULL` | row index in that submit, from 0 |

- Check `bills_client_batch_check`: both set or both null.
- Unique index `bills_household_client_batch_unique` on
  `(household_id, client_batch_id, client_batch_index)
  WHERE client_batch_id IS NOT NULL`. It has **no** `deleted_at` filter: a
  deleted bill keeps its key, so a replay does not bring it back.
- The unique index also serves the replay lookup by
  `(household_id, client_batch_id)`.
- Migration up/down; `migration:check` clean.

## 3. `POST /households/:hid/bills/manual-batch`

Guards as `POST /bills`: `JwtAuthGuard`, `HouseholdMemberGuard`.
`@Throttle({ default: { limit: 20, ttl: 60_000 } })` — at most 1000 bills a
minute per user; the global 100/min stays.

### Request

```json
{
  "client_batch_id": "uuid",
  "rows": [
    {
      "bill_date": "2026-11-09",
      "amount": 1.5,
      "category_id": "uuid",
      "sub_category_id": "uuid",
      "note": "coffee",
      "market_id": "uuid",
      "market_name": "Kiosk",
      "currency": "EUR"
    }
  ]
}
```

DTO rules (`ManualBatchDto`, `ManualBatchRowDto`):

- `client_batch_id`: UUID, required.
- `rows`: 1..`MAX_MANUAL_BATCH_ROWS` (50), `@ValidateNested`.
- `bill_date`: `@IsCalendarDate()`, not later than Chisinau today + 1 day
  (new validator next to `is-calendar-date`).
- `amount`: number, at most 2 decimals, `> 0`, `≤ MAX_MONEY_AMOUNT`.
- `category_id`: UUID, required. `sub_category_id`: UUID, optional.
- `note`: string, 1..255 (the length of `raw_name`), trimmed, optional.
- `market_id` (UUID) and `market_name` (string, 1..255, trimmed): at most one
  of them.
- `currency`: `Currency`, optional.

The global `ValidationPipe` reports DTO errors with their path, e.g.
`rows.3.amount must not be greater than ...`.

### What each row becomes

| bill | value |
|---|---|
| `source` | `manual` |
| `status` | `confirmed` (`confirmed_by` / `confirmed_at` stay null, as `POST /bills`) |
| `amount` | `row.amount` |
| `bill_date` | `row.bill_date` |
| `currency` | `row.currency ?? household.currency` — always set: a null currency leaves the bill unconverted (`householdConversionJoin` gives `factor = NULL`) |
| `market` | `row.market_id`, or found or created from `row.market_name`, or none |
| `created_by` | the caller |
| `client_batch_id` / `client_batch_index` | request key / row index |

One line (`bill_sub_categories`): `category` and `sub_category` through
`assignLineCategory`, `amount = row.amount`, `product_count = 1`,
`raw_name = note ?? sub_category.name ?? category.name`.

### Response

- `201 { client_batch_id, bills: BillResponseDto[] }` — in row order, each
  with `source` and the household conversion (`conversion.forBills`), as in
  `GET /bills`.
- A replay with a used key: `200` with the same shape, bills ordered by
  `client_batch_index`, deleted ones included.

### Errors

- DTO errors: `400` from `ValidationPipe`.
- Data errors: `400` with every bad row at once, nothing saved:

```json
{
  "statusCode": 400,
  "message": "Some rows are invalid",
  "errors": [{ "index": 2, "field": "category_id", "message": "Category not found" }]
}
```

Data errors: unknown or another household's (or deleted) category,
sub-category or market; a sub-category not in the row's category.

## 4. Flow (`ManualBillBatchService`)

A new service in `src/modules/bill/manual-bill-batch.service.ts`;
`bill-crud.service.ts` (1145 lines) does not grow. The free helpers
`lineCategoryOf`, `assignLineCategory` and `numberOrNull` move from
`bill-crud.service.ts` to `bill-lines.ts` and are imported by both.

1. **Replay fast path.** Find bills by `(household, client_batch_id)`
   (`deleted_at` ignored). Found → `200` with them.
2. **Checks, before the transaction.** One query for the rows' categories,
   one for their sub-categories (with category), one for their market ids —
   all limited to the household and to live rows. Collect every data error
   with its row index; any → `400`.
3. **Household currency**: one read of `households.currency`.
4. **Transaction** (`em.transactional`):
   - `MarketService.findOrCreate` once per distinct `market_name`,
     compared ignoring case (it runs in the caller's transaction and
     survives a concurrent insert);
   - create the bills and their lines, flush.
5. **Concurrent replay.** Two requests with the same new key: the second
   insert waits on the unique index and fails with
   `UniqueConstraintViolationException` once the first commits. Catch it
   (only for `bills_household_client_batch_unique`), read the bills by key,
   answer `200`.
6. **After commit:** warm rates once —
   `exchangeRates.ensureDays(dates, { max: dates.length })` for the distinct
   dates of rows whose currency is not the household's. Never throws, as
   `BillCrudService.warmRate`.
7. Build the response with `conversion.forBills(householdId, ids)`.

A failed check or write saves nothing: either every row becomes a bill or
none does.

## 5. `GET /households/:hid/categories/recent?limit=10`

In `CategoryController` (declared before `:id`), guards as the other category
routes.

- `limit`: 1..50, default 10.
- Returns distinct `(category, sub_category | null)` pairs from lines of the
  household's **confirmed** bills with `bill_date` in the last 90 days, any
  source, newest last use first (`max(bills.bill_date)`, then
  `max(bills.created_at)`).
- Skips deleted categories and sub-categories and deleted bills.
- Response: `[{ category: { id, name }, sub_category: { id, name } | null,
  last_used_at }]`.

## 6. Interaction with other work

- **Duplicates.** `possible_duplicates` is not computed or returned. A photo
  of a purchase that was typed by hand finds the manual bill through
  `findCandidates` (date + amount + market). A test pins this.
- **HAN-41 (bank import matching).** Must match `source = manual` bills too;
  noted as a comment on HAN-41, no work here.
- **HAN-49** (source in lists, editing a manual bill) builds on `source`.
- **Currency conversion** works unchanged because every manual bill has a
  currency.

## 7. Testing

Unit (DTO):

- `bill_date` after tomorrow rejected; today and tomorrow accepted.
- `market_id` with `market_name` rejected.
- 0 and 51 rows rejected; `amount` 0 or negative rejected; 3 decimals
  rejected; `note` over 255 rejected.

Integration:

- 10 rows → 10 confirmed bills with `source = manual`, one line each; visible
  in `GET /bills`, the dashboard and the spending breakdown by category
  (including a row without a sub-category).
- Bad category in row 3 → `400` with `index: 2`, `field: category_id`;
  no bill and no market saved.
- Another household's category, sub-category or market → `400`.
- A sub-category of another category → `400`.
- Same `client_batch_id` twice → same ids, `200`; two concurrent requests →
  one set of bills.
- Replay after deleting one bill of the batch → bill not recreated.
- No `currency` → the household's currency; a foreign currency converts.
- `market_name` "Kiosk" and "kiosk" in one batch → one market.
- A photo draft with the same date, amount and market lists the manual bill
  as a possible duplicate.
- `categories/recent`: order, `limit`, no deleted categories, no other
  household's data, no drafts.
