# Household currency and read-time conversion — design

Date: 2026-10-31
Status: implemented on feat/exchange-rates (amended by the final review)

## Goal

A household that spends in several currencies (EUR at home, MDL on a trip to
Moldova) can see **one total in its own currency** on the dashboard and in the
spending breakdown, and see each foreign bill's amount in that currency.

The original receipt stays the only stored truth: a bill keeps the currency
and amounts read off the receipt. Converted amounts are computed when read,
from official BNM rates **already saved in PostgreSQL**. The rate API
(mdl.md) is asked for a day at most once, ever.

### Decisions taken

- The target currency belongs to the **household**, not the user: bills are
  household-scoped and members may have different `users.currency`.
- **No converted amount is stored on bills.** Past official rates never
  change, so a stored copy would only add ways to go stale (date/currency
  edits, household currency changes, bills confirmed while mdl.md was down).
- **Parse-photo and drafts are untouched.** A draft is not spending; its date
  and currency can still change at confirm.
- mdl.md (`/api/v1/rates/{date}`) answers weekends and holidays with the
  previous working day's rates (checked 2026-10-24/25 and 2026-01-01), so
  every past day has rates. Only today, before BNM publishes, can be empty.

## 1. Data model

### `households.currency`

- New column `currency currency_enum NOT NULL`.
- Migration: add nullable, fill from the creator
  (`UPDATE households h SET currency = u.currency FROM users u WHERE u.id = h.created_by`),
  then `SET NOT NULL`. Regenerate the MikroORM snapshot.
- `Household.currency!: Currency` on the entity.
- `POST /households`: optional `currency`; defaults to the creator's
  `users.currency`.
- `PUT /households/:hid` (owner only, `assertOwner` as today):
  `UpdateHouseholdDto` gets an optional `currency`; `name` becomes optional
  too, and a body with neither is rejected with 400. The service method
  `renameHousehold` becomes `updateHousehold`.
- `HouseholdResponseDto` and `HouseholdDetailResponseDto` return `currency`.
- Changing the currency is a plain column update: nothing is recomputed,
  every converted number follows on the next read.

### Bills

No new columns. `bills.amount`, `bills.currency` and
`bill_sub_categories.amount` stay as on the receipt.

## 2. Saving rates ahead of reads

### `ExchangeRateService.ensureDays(dates, { max })`

```ts
/** Loads the days not saved yet, at most `max` of them; never throws. */
ensureDays(dates: string[], opts: { max: number }): Promise<{ missing: string[] }>
```

- Deduplicates `dates`; drops dates after Chisinau today (no call, no
  failure: their bills fall back to the latest saved rate).
- One query finds which dates already have an `exchange_rate_days` marker;
  only the others are fetched, oldest first, at most `max`, sequentially
  through the existing `ensureDay` (keeps in-flight sharing and
  `ON CONFLICT DO NOTHING`).
- A day the provider has no data for, older than 7 days (Chisinau), gets a
  marker with `currency_count = 0`, so it is asked once ever; a recent empty
  day stays unmarked and is asked again until BNM publishes.
- The first 503/429/timeout stops the loop: that date and the rest go into
  `missing` (one provider timeout per request at worst). Dates beyond `max`
  go into `missing` too. Nothing is thrown.

### When days are loaded

| Trigger | Dates | Cap | On failure |
|---|---|---|---|
| `POST /bills`, `POST /bills/:id/confirm`, `PUT /bills/:id` | the bill's `bill_date`, only when `bill.currency` is set and differs from the household currency | 1 | logged, ignored; response unchanged |
| `GET /dashboard`, `GET /dashboard/spending-breakdown` | distinct `bill_date` of confirmed bills in the range whose currency is set and differs from the household currency | 10 per request (mdl.md allows 300/hour per IP) | those bills land in `unconverted` |
| `GET /bills`, `GET /bills/:id` | none — saved rates only | — | `household_amount: null` |

The bill write paths call `ensureDays` **after** the transaction commits, so
a rate problem can never roll back or fail the write.

## 3. Conversion in SQL

One shared SQL fragment (a helper in `src/modules/bill/`, e.g.
`household-conversion.sql.ts`) yields, per bill, a `factor`:

```
factor = rate(bill.currency, d) / rate(household.currency, d)
rate(c, d) = 1                                   when c = 'MDL'
           = latest exchange_rates.rate with source = provider.source,
             currency = c, d - 7 <= rate_date <= d
             (LATERAL ... ORDER BY rate_date DESC LIMIT 1)
factor = 1     when bill.currency = household.currency
factor = NULL  when bill.currency IS NULL or either rate is missing
```

- `source` is always bound to `ExchangeRateProvider.source`, so test rates
  and a future second provider never mix.
- "Latest on or before, at most 7 days back" covers a bill dated today before
  BNM publishes; an older rate is never used — the bill is unconverted instead.
- Lines are converted then summed; the sum is rounded to cents once:
  `ROUND(SUM(l.amount * factor), 2)`. Bill totals: `ROUND(b.amount * factor, 2)`.
- Index `(source, currency, rate_date DESC)` (migration) serves the LATERAL
  lookup, also for currencies BNM does not quote.

## 4. API changes (additive only)

Existing fields, including `by_currency`, keep their meaning.

### Shared DTO

```ts
class UnconvertedDto {
  currency: Currency | null; // null = bills without a currency
  bill_count: number;
  amount: number;            // sum in that original currency
}
```

### `GET /households/:hid/bills/dashboard`

New `in_household_currency: DashboardHouseholdSeriesDto`, which is
`DashboardCurrencySeriesDto` (`currency` = household currency,
`period_totals` zero-filled, `category_stats` with percentages of the
converted categorized spend) plus `unconverted: UnconvertedDto[]`.
Each item of `bills[]` gains `household_amount: number | null`.

### `GET /households/:hid/bills/dashboard/spending-breakdown`

New `in_household_currency: SpendingHouseholdDto`, which is
`SpendingCurrencyDto` built by the existing `foldSpendingRows` from the
converted rows (currency forced to the household currency) plus
`unconverted`. With `?currency=X`, only bills in X are converted.

### `GET /households/:hid/bills` and `GET /households/:hid/bills/:id`

- Both gain `household_currency: Currency` and
  `household_amount: number | null`.
- Detail also gains `exchange_rate: { rate: number; rate_date: string } | null`
  — `rate` is the factor (household currency per one unit of the bill's
  currency, 6 decimals) and `rate_date` the day of the saved rates used (may
  be earlier than `bill_date`); `null` when same currency or not
  convertible.
- Filters (`currency`, `amount_range`) still apply to original amounts.

### Unchanged

`POST /bills/parse-photo`, `GET /bills/drafts`, draft image, delete.

## 5. Error handling

- Conversion never turns a successful request into a failure.
- Write paths: rate loading is post-commit and best-effort.
- Dashboard/breakdown: provider failures and the per-request cap only move
  bills into `unconverted`; the response is 200.
- List/detail: no provider calls; missing rate → `null`.
- Bills without a currency are always reported in `unconverted`, never
  silently dropped.

## 6. Testing (TDD, testcontainers Postgres, call-counting `StubProvider`)

- `exchange-rate.int-spec.ts` — `ensureDays`: respects `max` and reports the
  rest; saved days make zero calls; provider 503/404 reported, not thrown;
  future dates skipped without a call.
- Household — migration backfills the creator's currency; create defaults to
  the creator's currency; `PUT` currency by owner works, by member is 403;
  empty body is 400.
- `bill-dashboard` int-spec (new) and `spending-breakdown.int-spec.ts` —
  EUR household with EUR + MDL bills sums correctly; category shares use
  converted amounts; weekend bill uses its own date's rate; bill dated today
  with no rate yet uses the previous day; no-currency bills in
  `unconverted`; `?currency=MDL` converts only MDL; more than 10 missing days
  → 10 fetched, rest unconverted; **a second identical request makes zero
  provider calls**; provider down → 200 with bills in `unconverted`.
- `bill-confirm.int-spec.ts` — confirming an MDL bill in an EUR household
  saves that day; provider 503 → confirm still 200 and bill confirmed;
  same-currency bill makes no call.
- `bill-queries.int-spec.ts` — `household_amount` on list and detail,
  `exchange_rate` on detail, `null` without a saved rate, **zero provider
  calls**.
- e2e — one smoke test of `GET /dashboard` with a stubbed provider asserting
  the new fields.

## Out of scope

- A backfill job warming rates for old bills (the dashboard fills them, 10
  days per request).
- Conversion of drafts or in parse-photo.
- Per-user display currency or a `?convert_to` override.
- Filtering the bill list by converted amount.
