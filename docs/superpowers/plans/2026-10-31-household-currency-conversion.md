# Household Currency and Read-time Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every household a currency and show bills, dashboard totals and the spending breakdown converted into it, computed at read time from BNM rates already saved in PostgreSQL.

**Architecture:** `households.currency` is the target. Bills keep only original amounts. One shared SQL join (`householdConversionJoin`) yields a per-bill `factor` from the latest saved `exchange_rates` row on or before `bill_date`. Write paths and the two aggregation endpoints call a new non-throwing `ExchangeRateService.ensureDays` so rates are saved before they are read; list/detail never call the provider.

**Tech Stack:** NestJS, MikroORM (PostgreSQL, raw SQL via `em.getConnection().execute`), Jest (unit `*.spec.ts`; integration `*.int-spec.ts` / `*.e2e-spec.ts` against a real Postgres via `test/jest-e2e.json`).

**Spec:** `docs/superpowers/specs/2026-10-31-household-currency-conversion-design.md`

## Global Constraints

- Bills store no converted values; `bills.amount`, `bills.currency`, `bill_sub_categories.amount` are untouched.
- `POST /bills/parse-photo`, drafts list, draft image, delete: unchanged.
- All API changes are additive; `by_currency` and existing fields keep their meaning.
- Rates: latest `exchange_rates` row with `source = ExchangeRateService.source`, same currency, `rate_date <= bill_date`. MDL rate is `1`.
- `factor = 1` when bill currency = household currency; `NULL` when bill currency is NULL or a needed rate is missing.
- Rounding: bill totals `ROUND(b.amount * factor, 2)`; aggregates `ROUND(SUM(l.amount * factor), 2)` — round once, after summing.
- Fetch caps: write paths `max: 1`; dashboard and breakdown `max: 10` per request; list/detail `0` (never fetch).
- Conversion never fails a request: provider 404/503/timeout is logged at `warn` and swallowed.
- Write-path rate loading runs **after** the transaction commits.
- Integration test command: `NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/jest-e2e.json <file>`; unit: `npm test -- <file>`.

## Review Focus

1. **Household currency is MDL** (a Moldovan household with EUR bills): factor must be `rate(EUR) / 1`, not NULL because no `exchange_rates` row exists for MDL. → test in Task 3.
2. **Bill in MDL, household in EUR, bill date is a day the provider has nothing for yet** (e.g. today before BNM publishes): uses the previous saved day, not NULL. → test in Task 3.
3. **User edits a confirmed bill's currency or date with `PUT`**: next read reflects it (no stale value) and the new day is saved. → test in Task 4.
4. **Owner switches household currency EUR→USD**: next dashboard read is in USD with no recompute step; dashboard must load the USD rate days too (same day markers, so no extra fetch when the day is saved). → test in Task 5.
5. **Many old foreign bills over a year range** (more than 10 unsaved days): response is 200, at most 10 provider calls, remaining bills listed in `unconverted`, next request fetches the next 10. → test in Task 5.

## File Structure

- Create `src/migrations/Migration20261031180000_AddHouseholdCurrency.ts` — column + backfill.
- Modify `src/entities/household.entity.ts` — `currency`.
- Modify `src/modules/household/{household.service.ts,household.controller.ts,dto/*.ts}`, `src/modules/auth/auth.service.ts` — set/update/return currency.
- Modify `src/modules/exchange-rate/exchange-rate.service.ts` — `source`, `ensureDays`.
- Create `src/modules/exchange-rate/testing/stub-exchange-rate.provider.ts` — the call-counting stub, moved out of `exchange-rate.int-spec.ts` for reuse.
- Create `src/modules/bill/household-conversion.ts` — SQL join fragment, unconverted query, `BillConversionService` (per-bill lookups).
- Create `src/modules/bill/dto/household-conversion.dto.ts` — `UnconvertedDto`, `BillExchangeRateDto`.
- Modify bill services/DTOs: `bill-crud.service.ts`, `bill-dashboard.service.ts`, `spending-breakdown.service.ts`, `dto/bill-response.dto.ts`, `dto/bill-detail-response.dto.ts`, `dto/bill-dashboard.dto.ts`, `dto/spending-breakdown.dto.ts`, `bill.module.ts`, `bill.controller.ts` (Swagger text).
- Create `src/modules/bill/household-conversion.int-spec.ts` — shared fixture, grown task by task.
- Create `test/household-currency.e2e-spec.ts` — smoke.

---

### Task 1: Household currency

**Files:**
- Create: `src/migrations/Migration20261031180000_AddHouseholdCurrency.ts`, regenerate `src/migrations/.snapshot-accounting.json`
- Modify: `src/entities/household.entity.ts`, `src/modules/household/dto/create-household.dto.ts`, `src/modules/household/dto/update-household.dto.ts`, `src/modules/household/dto/household-response.dto.ts`, `src/modules/household/household.service.ts:56-120,338-345`, `src/modules/household/household.controller.ts:73-85`, `src/modules/auth/auth.service.ts:250-252`
- Test: `src/modules/household/household.service.spec.ts`, `test/household-invites.e2e-spec.ts` (or a new `test/household-currency.e2e-spec.ts` section for HTTP checks)

**Interfaces:**
- Produces: `Household.currency: Currency` (non-null); `HouseholdResponseDto.currency: Currency`; `HouseholdService.updateHousehold(hid: string, dto: UpdateHouseholdDto): Promise<HouseholdResponseDto>` (replaces `renameHousehold`); `createHousehold(userId, dto)` defaults currency to the creator's `users.currency`.

- [ ] **Step 1: Write failing tests**
  - `household.service.spec.ts`:
    - `createHousehold without currency uses the creator's currency` → user with `currency: MDL`, result `currency === 'MDL'`.
    - `createHousehold with currency USD keeps USD`.
    - `updateHousehold changes only currency when name is absent` → name unchanged, currency `USD`.
  - e2e (`test/household-currency.e2e-spec.ts`):
    - `PUT /households/:hid {currency:'USD'}` by owner → 200, body `currency: 'USD'`.
    - same by a member → 403.
    - `PUT /households/:hid {}` → 400.
    - `POST /auth/register` then `GET /households` → personal household has `currency: 'EUR'`.
- [ ] **Step 2: Run, expect FAIL** (`currency` undefined / `updateHousehold` not a function).
- [ ] **Step 3: Migration** `up()`: `alter table "households" add column "currency" "currency_enum" null;` → `update "households" h set "currency" = u."currency" from "users" u where u."id" = h."created_by";` → `alter table "households" alter column "currency" set not null;`. `down()` drops the column. Entity: `@Enum({ items: () => Currency, type: 'enum', nativeEnumName: 'currency_enum', nullable: false }) currency!: Currency;` (no DB default). Regenerate the snapshot with the project's MikroORM CLI the way commit `f757bc6` did.
- [ ] **Step 4: DTOs and service.** `CreateHouseholdDto.currency?: Currency` (`@IsOptional() @IsEnum(Currency)`). `UpdateHouseholdDto`: `name?` and `currency?`, both optional; `updateHousehold` throws `BadRequestException('Nothing to update')` when both are undefined. `createHousehold` loads the creator's currency when `dto.currency` is absent. `auth.service.ts` register sets `household.currency = user.currency`. `toDto` adds `currency`. Controller `PUT :hid` calls `updateHousehold`; summary `'Rename the household or change its currency (owner only)'`.
- [ ] **Step 5: Run unit + e2e tests, expect PASS;** also `npm run build`.
- [ ] **Step 6: Commit** `feat(household): add household currency`.

---

### Task 2: `ExchangeRateService.ensureDays`

**Files:**
- Modify: `src/modules/exchange-rate/exchange-rate.service.ts`
- Create: `src/modules/exchange-rate/testing/stub-exchange-rate.provider.ts` (move `StubProvider` from `exchange-rate.int-spec.ts`, export it; constructor takes `source = 'TEST'`)
- Test: `src/modules/exchange-rate/exchange-rate.int-spec.ts`

**Interfaces:**
- Produces:
  - `ExchangeRateService.source: string` (getter returning `provider.source`).
  - `ExchangeRateService.ensureDays(dates: string[], opts: { max: number }): Promise<{ missing: string[] }>` — never throws.
  - `StubProvider { source; calls: string[]; answer: (date) => Promise<FetchedDay | null> }`.

- [ ] **Step 1: Write failing tests** (each uses `nextDate()` days):
  - `ensureDays fetches only unsaved days, oldest first, up to max` → 3 new dates, `max: 2` → `provider.calls` = two oldest; `missing` = the newest.
  - `ensureDays makes no call for saved days` → save day via `getRate`, reset `calls`, `ensureDays([d,d])` → `calls` `[]`, `missing` `[]`.
  - `ensureDays reports a provider failure instead of throwing` → `answer` rejects with `ServiceUnavailableException` → resolves `{ missing: [d] }`.
  - `ensureDays reports an empty day as missing` → `answer` returns `null` → `missing: [d]`.
  - `ensureDays skips future dates without a call` → tomorrow (Chisinau) → `calls` `[]`, `missing: [tomorrow]`.
  - `ensureDays with max 0 makes no call`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Dedupe and sort ascending; split off dates `> chisinauToday()`; one `SELECT rate_date::text FROM exchange_rate_days WHERE source = ? AND rate_date = ANY(?)`; for the first `max` unsaved dates call the existing `ensureDay` sequentially inside try/catch (log `warn` with the date and message); everything not saved goes into `missing`. Invalid `YYYY-MM-DD` strings are treated as missing (no throw).
- [ ] **Step 4: Run, expect PASS** (whole file, existing tests included).
- [ ] **Step 5: Commit** `feat(exchange-rate): ensureDays loads unsaved days without throwing`.

---

### Task 3: Conversion SQL and bill list/detail fields

**Files:**
- Create: `src/modules/bill/household-conversion.ts`, `src/modules/bill/dto/household-conversion.dto.ts`, `src/modules/bill/household-conversion.int-spec.ts`
- Modify: `src/modules/bill/bill.module.ts` (import `ExchangeRateModule`, provide `BillConversionService`), `src/modules/bill/bill-crud.service.ts` (`listBills`, `getBill`), `src/modules/bill/dto/bill-response.dto.ts`, `src/modules/bill/dto/bill-detail-response.dto.ts`
- Modify (test setup only): `src/modules/bill/bill-queries.int-spec.ts`, `bill-confirm.int-spec.ts`, `spending-breakdown.int-spec.ts`, `bill-draft-from-ai.int-spec.ts`, `bill-crud.service.spec.ts`, `bill.controller.spec.ts` — provide `ExchangeRateService` with `StubProvider` / mocks so they compile and stay green.

**Interfaces:**
- Consumes: `Household.currency` (Task 1), `ExchangeRateService.source` (Task 2).
- Produces (in `household-conversion.ts`):
  - `householdConversionJoin(bill = 'b'): string` — SQL placed right after `FROM bills <bill>`; contains exactly **two** `?` placeholders, both bound to `source`. Exposes columns `h.currency AS household_currency`, `fx.factor` (numeric or NULL), `fx.rate_date` (date or NULL). Shape: `JOIN households h ON h.id = b.household_id`, then a `LEFT JOIN LATERAL` for the bill currency's latest rate `<= b.bill_date` (skipped when NULL or `'MDL'`), one for the household currency's, then `CROSS JOIN LATERAL (SELECT CASE ... END AS factor, COALESCE(rf.rate_date, rt.rate_date) AS rate_date) fx`, with `'MDL'` → 1 and same currency → 1, rate_date NULL.
  - `fetchUnconverted(conn, source: string, householdId: string, start: string, end: string, currency?: Currency): Promise<UnconvertedDto[]>` — confirmed, not deleted bills in `[start, end)` with `factor IS NULL`, grouped by `b.currency`, sorted by code, NULL last; `amount` = `SUM(b.amount)` in original currency.
  - `@Injectable() BillConversionService.forBills(householdId: string, billIds: string[]): Promise<Map<string, BillConversion>>` where `BillConversion = { household_currency: Currency; household_amount: number | null; exchange_rate: BillExchangeRateDto | null }`; `exchange_rate` is null when factor is 1 or NULL; `rate` = factor rounded to 6 decimals, `rate_date` `YYYY-MM-DD`.
- DTOs: `UnconvertedDto { currency: Currency | null; bill_count: number; amount: number }`; `BillExchangeRateDto { rate: number; rate_date: string }`. `BillResponseDto` gains `household_currency?: Currency`, `household_amount?: number | null`; `BillDetailResponseDto` gains `exchange_rate?: BillExchangeRateDto | null`. Optional because the drafts list does not fill them.

Fixture for `household-conversion.int-spec.ts` (testing module overrides `EXCHANGE_RATE_PROVIDER` with `new StubProvider('TEST-HC')`; `afterAll` deletes that source's rows). Stub rates in MDL per unit:
| day | EUR | USD |
|---|---|---|
| 2026-03-02 (Mon) | 20.0 | 18.0 |
| 2026-03-07 (Sat) | 25.0 | 18.0 |
| 2026-03-09 | provider returns `null` | |
Household `EUR`, categories Food and Home. Bills (one line equal to the total unless stated): EUR 10.00 on 03-02 (Food); MDL 200.00 on 03-02 (lines Food 120 + Home 80); MDL 200.00 on 03-07 (Food); MDL 100.00 on 03-09 (Food); NULL-currency 31.00 on 03-02 (Food). Converted: Food 10 + 6 + 8 + 4 = 28.00, Home 4.00, total 32.00.

- [ ] **Step 1: Write failing tests** (save days 03-02 and 03-07 via `ensureDays` in `beforeAll`; leave 03-09 unsaved):
  - `list: EUR bill has household_amount 10 and factor 1`.
  - `list: MDL 200 on 03-02 → household_amount 10.00`.
  - `list: MDL 200 on Saturday 03-07 uses that day's rate → 8.00`.
  - `list: MDL 100 on 03-09 with no saved day uses 03-07 → 4.00` (Review Focus 2).
  - `list: NULL-currency bill → household_amount null`.
  - `detail: MDL bill on 03-09 → exchange_rate { rate: 0.04, rate_date: '2026-03-07' }`.
  - `detail: EUR bill → exchange_rate null`.
  - `list and detail make zero provider calls` → reset `calls` before, assert `[]`.
  - `MDL household: EUR 10 on 03-02 → household_amount 200.00` (Review Focus 1; second household, currency MDL).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the helpers, DTOs and module wiring. `listBills`: add `householdConversionJoin('b')` after `FROM bills b` in the data query only, prepend `[source, source]` to its params (after `itemTolerance`, which stays first), select `household_currency`, `ROUND(b.amount * fx.factor, 2)::text AS household_amount`. `getBill`: after loading, merge `BillConversionService.forBills(householdId, [id])`.
- [ ] **Step 4: Run** the new int-spec plus all existing bill int-specs and `npm test`; expect PASS.
- [ ] **Step 5: Commit** `feat(bill): household-currency amount on bill list and detail`.

---

### Task 4: Save rates on bill writes

**Files:**
- Modify: `src/modules/bill/bill-crud.service.ts` (`createBill`, `confirmBill`, `updateBill`)
- Test: `src/modules/bill/household-conversion.int-spec.ts`, `src/modules/bill/bill-confirm.int-spec.ts`

**Interfaces:**
- Consumes: `ExchangeRateService.ensureDays` (Task 2), `BillConversionService.forBills` (Task 3).
- Produces: private `BillCrudService.warmRate(householdId: string, bill: Bill): Promise<void>` — no-op unless `bill.currency` is set and differs from the household currency; otherwise `ensureDays([bill.bill_date], { max: 1 })`.

- [ ] **Step 1: Write failing tests:**
  - `confirming an MDL draft in an EUR household saves its day` → day unsaved before, `provider.calls` = `[bill_date]`, response `household_amount` set.
  - `confirm succeeds when the provider is down` → stub rejects with `ServiceUnavailableException`; response 200-shaped, bill `status confirmed`, `household_amount` null.
  - `confirming an EUR bill in an EUR household makes no call`.
  - `PUT changing currency EUR→MDL and date to a new day saves that day and returns the new household_amount` (Review Focus 3).
  - `createBill with MDL saves its day`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** In each of the three methods, after the flush / after `em.transactional(...)` resolves, `await this.warmRate(...)`, then merge `forBills` into the returned DTO.
- [ ] **Step 4: Run** both int-specs and `npm test`; expect PASS.
- [ ] **Step 5: Commit** `feat(bill): save the day's rates when a bill is written`.

---

### Task 5: Dashboard in household currency

**Files:**
- Modify: `src/modules/bill/bill-dashboard.service.ts`, `src/modules/bill/dto/bill-dashboard.dto.ts`, `src/modules/bill/bill.controller.ts` (`getDashboard` description)
- Test: `src/modules/bill/household-conversion.int-spec.ts`, `src/modules/bill/bill-dashboard.service.spec.ts` (keep green)

**Interfaces:**
- Consumes: `householdConversionJoin`, `fetchUnconverted`, `ensureDays`.
- Produces: `loadRateDays(conn, rates: ExchangeRateService, householdId: string, start: string, end: string, currency?: Currency): Promise<Currency>` in `household-conversion.ts` — loads up to 10 unsaved days for the range's foreign bills and returns the household currency; `DashboardHouseholdSeriesDto extends DashboardCurrencySeriesDto { unconverted: UnconvertedDto[] }`; `BillDashboardResponseDto.in_household_currency: DashboardHouseholdSeriesDto`; `DashboardBillSummaryDto.household_amount: number | null`.

- [ ] **Step 1: Write failing tests** (`type: 'month', year: 2026, month: 3`):
  - `period_totals sum EUR and converted MDL` → `2026-03-02` total `20.00` (10 + 10), `2026-03-07` `8.00`, `2026-03-09` `4.00`.
  - `category_stats use converted line amounts` → Food `28.00` (87.5 %), Home `4.00` (12.5 %).
  - `unconverted lists the NULL-currency bill` → `[{ currency: null, bill_count: 1, amount: 31 }]`.
  - `bills[] carry household_amount`.
  - `a second identical request makes zero provider calls`.
  - `provider down → still resolves, unsaved-day bills appear in unconverted` (MDL bill in 2024-01, earlier than every saved day so no fallback exists).
  - `more than 10 unsaved days → 10 calls, the rest in unconverted; the next request fetches the remaining` (Review Focus 5; 12 MDL bills on 12 distinct unsaved days in 2025-01 — earlier than every March 2026 day, so fallback can't fill the unfetched ones).
  - `switching household currency to USD converts everything to USD without a fetch` → after `UPDATE households SET currency='USD'`, 03-02 EUR 10 → `11.11`, MDL 200 → `11.11` (Review Focus 4).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `loadRateDays`: read the household currency, select distinct `bill_date::text` of confirmed, not deleted bills in range whose currency is set and differs from it, `ensureDays(dates, { max: 10 })`. Call it before the existing queries. `fetchBills` gains the join and `ROUND(b.amount * fx.factor, 2)` as `household_amount`. Then in parallel with the existing queries: converted period totals and converted category stats (same SQL as today with `householdConversionJoin`, `WHERE fx.factor IS NOT NULL`, amounts `ROUND(SUM(... * fx.factor), 2)`), and `fetchUnconverted`. Reuse `fillGaps` and `computePercentages` for the series; `currency` = household currency (read once with the date query).
- [ ] **Step 4: Run** int-specs and `npm test`; expect PASS.
- [ ] **Step 5: Commit** `feat(bill): dashboard totals in the household currency`.

---

### Task 6: Spending breakdown in household currency

**Files:**
- Modify: `src/modules/bill/spending-breakdown.service.ts`, `src/modules/bill/dto/spending-breakdown.dto.ts`, `src/modules/bill/bill.controller.ts` (description), `src/modules/bill/dto/api-responses.decorator.ts` (example text if it shows the body)
- Test: `src/modules/bill/household-conversion.int-spec.ts`

**Interfaces:**
- Consumes: `loadRateDays` (Task 5), `householdConversionJoin`, `fetchUnconverted`.
- Produces: `SpendingHouseholdDto extends SpendingCurrencyDto { unconverted: UnconvertedDto[] }`; `SpendingBreakdownResponseDto.in_household_currency: SpendingHouseholdDto`.

- [ ] **Step 1: Write failing tests** (March 2026 custom range):
  - `in_household_currency` for March 2026 → `total` `32.00`, Food `28.00`, Home `4.00`, NULL-currency bill not counted.
  - `?currency=MDL converts only MDL bills` → EUR bill excluded; unconverted empty.
  - `NULL-currency bills only in unconverted`.
  - `in_household_currency.currency` is the household currency and `by_currency` is unchanged.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add a second aggregate in the same transaction: the existing `agg` CTE with `householdConversionJoin('b')`, `fx.factor IS NOT NULL`, `SUM(l.amount * fx.factor)` grouped by `l.sub_category_id` only, selecting the household currency as `currency`; feed it to `foldSpendingRows` and take its single element (or an empty tree with total 0 when there are no rows). Round totals as the existing fold does.
- [ ] **Step 4: Run** int-specs, `test/spending-breakdown.e2e-spec.ts`, `npm test`; expect PASS.
- [ ] **Step 5: Commit** `feat(bill): spending breakdown in the household currency`.

---

### Task 7: End-to-end smoke and final checks

**Files:**
- Test: `test/household-currency.e2e-spec.ts` (from Task 1; add a dashboard case). Override `EXCHANGE_RATE_PROVIDER` with `StubProvider` like the other e2e overrides.

- [ ] **Step 1: Write the test:** register, create an MDL bill via `POST /households/:hid/bills`, `GET .../bills/dashboard?type=month&...` → body has `in_household_currency.currency === 'EUR'`, a non-zero converted total, `unconverted: []`, `bills[0].household_amount` a number; `GET .../dashboard/spending-breakdown` has `in_household_currency`.
- [ ] **Step 2: Run, expect PASS** (behaviour already built).
- [ ] **Step 3:** `npm run lint`, `npm run build`, `npm test`, full `npx jest --config ./test/jest-e2e.json`; all green.
- [ ] **Step 4:** Apply the migration on the dev database (`npx mikro-orm migration:up`) and check `select count(*) from households where currency is null` = 0.
- [ ] **Step 5: Commit** `test(e2e): household currency conversion smoke test`.
