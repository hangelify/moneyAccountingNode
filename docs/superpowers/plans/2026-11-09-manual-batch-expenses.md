# Manual Expenses in a Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bills.source` (HAN-65), then `POST /households/:hid/bills/manual-batch` and `GET /households/:hid/categories/recent` (HAN-48).

**Architecture:** Each manual row becomes a confirmed one-line bill with `source = manual`. A new `ManualBillBatchService` validates every row up front, writes all rows in one transaction, and is idempotent through a unique `(household_id, client_batch_id, client_batch_index)` index on `bills`. The recent-categories query lives in `CategoryService`.

**Tech Stack:** NestJS, MikroORM (PostgreSQL), class-validator, Jest (`npm run test` for unit tests, `npm run test:e2e` for `*.int-spec.ts` and `*.e2e-spec.ts` against a real database).

**Spec:** `docs/superpowers/specs/2026-11-09-manual-batch-expenses-design.md` (Linear document "Spec: Manual expenses in a batch (HAN-48)").

## Global Constraints

- Two PRs into `dev`. Branch `feat/han-65-bill-source` ("Fixes HAN-65") merges first. Then branch `feat/han-48-manual-batch` from the updated `dev` ("Fixes HAN-48").
- `MAX_MANUAL_BATCH_ROWS = 50`. Rows are indexed from 0.
- `bill_date` must be on or before Chisinau today + 1 day. There is no lower bound.
- `amount`: greater than 0, at most 2 decimals, `≤ MAX_MONEY_AMOUNT`. `note` and `market_name`: trimmed, length 1..255. `market_id` and `market_name` are mutually exclusive.
- `raw_name = note ?? sub_category.name ?? category.name`. `product_count = 1`. `currency = row.currency ?? household.currency`, never null.
- Data-error body: `{ statusCode: 400, message: 'Some rows are invalid', errors: [{ index, field, message }] }`.
- Endpoint throttle: `@Throttle({ default: { limit: 20, ttl: 60_000 } })`.
- `categories/recent`: `limit` 1..50, default 10. Lines of confirmed, non-deleted bills with `bill_date >= today - 90 days`.
- Every migration has an `up` and a `down`, and `npm run migration:check` must be clean. Commit messages follow the repo's conventional style (`feat(bill): …`).
- Linear: create branch → set the issue to In Progress and comment with the branch name. Open PR → In Review with the PR link. Merge → Done and comment with the merge hash.

## Review Focus

1. **Two identical submits racing.** The second request must answer `200` with the first request's bills and leave no partial rows. Pinned in Task 6.
2. **`market_name` differing only in case within a batch, or matching an existing deleted market.** A single live market is used or created, and the deleted one is never reused. Pinned in Task 6.
3. **The same `client_batch_id` in another household.** Treated as a new batch and never answered with the other household's bills. Pinned in Task 6.
4. **A replay after a category was deleted.** It still answers `200` with the stored bills, with no re-validation. Pinned in Task 6.
5. **`note` that is whitespace only.** After trimming it is empty and gets rejected, so it never becomes an empty `raw_name`. Pinned in Task 4.

---

## Part A — HAN-65 `bills.source`

### Task 1: `bill_source` enum, column, writers and responses

**Files:**
- Create: `src/types/bill-source.enum.ts`
- Create: `src/migrations/Migration20261109140000_AddBillSource.ts`
- Modify: `src/entities/bill.entity.ts` (the new `source` property)
- Modify: `src/modules/bill/bill-crud.service.ts` (`createBill` sets `MANUAL`; the two `new Bill()` calls in `createDraftFromParsed` and the failed-bill path set `PHOTO`; the `listBills` SQL selects `b.source`; `toListDto` maps it)
- Modify: `src/modules/bill/dto/bill-response.dto.ts` (`source` field)
- Test: `src/modules/bill/bill-source.int-spec.ts`

**Interfaces:**
- Produces: `export enum BillSource { PHOTO = 'photo', MANUAL = 'manual', BANK = 'bank' }`; `Bill.source: BillSource`, native enum `bill_source`, `NOT NULL`, no default in the entity; `BillResponseDto.source: BillSource` (`@ApiProperty({ enum: BillSource, enumName: 'BillSource' })`), which `BillDetailResponseDto` inherits.

- [ ] **Step 1: Create the branch `feat/han-65-bill-source` from `dev`, then move HAN-65 to In Progress with a comment naming the branch.**
- [ ] **Step 2: Write the failing int-spec `bill-source.int-spec.ts`.** Use the harness from `bill-list-order.int-spec.ts` (`crud()` factory, raw `sql`).
  - `createBill` returns `source: 'manual'`.
  - `createDraftFromParsed` stores `source = 'photo'`.
  - `listBills` rows carry `source`.
  - Migration backfill: insert a bill with `ai_request_id` set and one without, run the backfill `UPDATE` from the migration through `sql`, and expect `photo` and `manual`.
- [ ] **Step 3: Run `npm run test:e2e -- bill-source`.** Expected: FAIL, because column `source` does not exist.
- [ ] **Step 4: Write the migration.**
  - `up`: `create type "bill_source" as enum ('photo','manual','bank')` → add `source "bill_source" null` → `update bills set source = case when ai_request_id is not null then 'photo' else 'manual' end` → `alter column source set not null`.
  - `down`: drop the column, then the type.
  - Export the backfill SQL as a `const` so the int-spec reuses it.
- [ ] **Step 5: Add the entity property and the enum, make the writers set `source`, add the DTO field and the `listBills` select.**
- [ ] **Step 6: Run `npm run migration:check`, `npm run test`, `npm run test:e2e`.** Expected: all green, and `migration:check` reports no diff.
- [ ] **Step 7: Commit** `feat(bill): record where each bill came from (photo, manual, bank)`, push, open the PR into `dev` with `Fixes HAN-65`, and move HAN-65 to In Review. Part B starts after the merge (HAN-65 → Done, with the hash).

---

## Part B — HAN-48 manual batch

Branch `feat/han-48-manual-batch` from `dev` after the HAN-65 merge. Move HAN-48 to In Progress with a comment naming the branch.

### Task 2: Shared bill-line helpers

**Files:**
- Create: `src/modules/bill/bill-lines.ts`
- Modify: `src/modules/bill/bill-crud.service.ts` (remove the moved code and import it)

**Interfaces:**
- Produces, exported from `bill-lines.ts` and moved unchanged:
  - `lineCategoryOf`, `assignLineCategory`, `numberOrNull`, `toCategoryRef`, the `LineCategories` type;
  - `toMarketRef(market?: Market): BillMarketRefDto | undefined` (was a private method);
  - `toBillResponse(bill: Bill, items: BillSubCategory[], itemTolerance: number): BillResponseDto` (was the private `toListDto`; `BillCrudService.toListDto` now calls it).

- [ ] **Step 1: Move the code.** This is a pure refactor with no behaviour change.
- [ ] **Step 2: Run `npm run test` and `npm run test:e2e -- bill-`.** Expected: all existing bill tests pass unchanged.
- [ ] **Step 3: Commit** `refactor(bill): share bill-line helpers`.

### Task 3: `client_batch_id` / `client_batch_index` columns

**Files:**
- Create: `src/migrations/Migration20261109150000_AddBillClientBatch.ts`
- Modify: `src/entities/bill.entity.ts`

**Interfaces:**
- Produces: `Bill.client_batch_id?: string | null` (`uuid`); `Bill.client_batch_index?: number | null` (`smallint`); check `bills_client_batch_check` = `(client_batch_id is null) = (client_batch_index is null)`; the unique index constant `BILLS_CLIENT_BATCH_UNIQUE = 'bills_household_client_batch_unique'` exported from `bill.entity.ts`, on `("household_id","client_batch_id","client_batch_index") where "client_batch_id" is not null`, declared through `@Index({ expression })` and `@Check`, like the other indexes in the entity.

- [ ] **Step 1: Write the migration** (`up`: two columns, the check and the unique index; `down`: drop them), then add the entity properties and decorators.
- [ ] **Step 2: Run `npm run migration:check`.** Expected: clean.
- [ ] **Step 3: Commit** `feat(bill): store the client batch key on bills`.

### Task 4: Request DTO and date validator

**Files:**
- Modify: `src/common/utils/calendar-date.ts` (export `chisinauToday(now?: Date): string`, moved from `exchange-rate.service.ts`, which now imports it, and `addCalendarDays(day: string, n: number): string`)
- Create: `src/common/validators/not-after-tomorrow.ts`
- Create: `src/modules/bill/dto/manual-batch.dto.ts`
- Test: `src/common/validators/not-after-tomorrow.spec.ts`, `src/modules/bill/dto/manual-batch.dto.spec.ts`

**Interfaces:**
- Produces:
  - `NotAfterTomorrow(opts?: ValidationOptions): PropertyDecorator`. It is valid when `value <= addCalendarDays(chisinauToday(), 1)` and skips non-strings, leaving them to `IsCalendarDate`. Message: `$property must not be later than tomorrow`.
  - `MAX_MANUAL_BATCH_ROWS = 50`.
  - `ManualBatchRowDto { bill_date; amount; category_id; sub_category_id?; note?; market_id?; market_name?; currency? }`.
  - `ManualBatchDto { client_batch_id: string; rows: ManualBatchRowDto[] }`.
  - Trimming uses `@Transform` (trim strings). The exclusive markets use `@ValidateIf((o) => o.market_name != null)` + `@IsEmpty({ message: 'Send market_id or market_name, not both' })` on `market_id`.

- [ ] **Step 1: Write the failing unit tests.** Build each case with `plainToInstance` + `validate`. Freeze `chisinauToday` with `jest.useFakeTimers().setSystemTime(new Date('2026-11-09T12:00:00Z'))`.
  - `bill_date` `'2026-11-10'` ok; `'2026-11-11'` → `notAfterTomorrow`; `'2020-01-01'` ok.
  - At 2026-11-09T23:30Z (01:30 on 2026-11-10 in Chisinau), `'2026-11-11'` is ok.
  - 0 rows → `arrayMinSize`; 51 rows → `arrayMaxSize`.
  - `amount` 0, -1 and 1.234 rejected; 1.5 accepted.
  - A `note` of 256 characters and a `note` of `'   '` rejected; `' coffee '` becomes `'coffee'`.
  - `market_id` together with `market_name` rejected.
  - A missing `category_id` is rejected; `client_batch_id` that is not a UUID is rejected.
- [ ] **Step 2: Run `npm run test -- not-after-tomorrow manual-batch.dto`.** Expected: FAIL, the modules do not exist yet.
- [ ] **Step 3: Implement the validator, the date helpers and the DTO**, reusing `IsCalendarDate`, `MaxDecimalPlaces` and `MAX_MONEY_AMOUNT` as `CreateBillDto` does.
- [ ] **Step 4: Run the same command.** Expected: PASS. Also run `npm run test -- exchange-rate`: green.
- [ ] **Step 5: Commit** `feat(bill): validate a manual expense batch`.

### Task 5: Response DTO

**Files:**
- Create: `src/modules/bill/dto/manual-batch-response.dto.ts`

**Interfaces:**
- Produces:
  - `ManualBatchResponseDto { client_batch_id: string; bills: BillResponseDto[] }`;
  - `ManualBatchRowErrorDto { index: number; field: string; message: string }`;
  - `ManualBatchErrorResponseDto { statusCode: 400; message: string; errors: ManualBatchRowErrorDto[] }` (for Swagger).

- [ ] **Step 1: Write the DTOs with `@ApiProperty`. Fold the commit into Task 6.**

### Task 6: `ManualBillBatchService`

**Files:**
- Create: `src/modules/bill/manual-bill-batch.service.ts`
- Modify: `src/modules/bill/bill.module.ts` (provider)
- Test: `src/modules/bill/manual-bill-batch.int-spec.ts`

**Interfaces:**
- Consumes: Task 2 helpers; Task 3 columns and `BILLS_CLIENT_BATCH_UNIQUE`; Task 4/5 DTOs; `MarketService.findOrCreate(em, householdId, { name })`; `ExchangeRateService.ensureDays(dates, { max })`; `BillConversionService.forBills(householdId, ids)`; `BillSource.MANUAL`.
- Produces:
  - `class ManualBillBatchService`, with constructor `(em: EntityManager, markets: MarketService, exchangeRates: ExchangeRateService, conversion: BillConversionService, @Optional() @Inject(BILL_ITEM_TOLERANCE) itemTolerance = DEFAULT_BILL_ITEM_TOLERANCE)`;
  - `createBatch(householdId: string, userId: string, dto: ManualBatchDto): Promise<{ created: boolean; body: ManualBatchResponseDto }>`. `created` is false on a replay.

Flow (spec §4):
1. Replay lookup by `(household, client_batch_id)` with deleted bills included, ordered by `client_batch_index`.
2. Load categories, sub-categories (with `category`) and markets in one query per kind, live and in this household. Collect `errors[]` per row, with `field` set to `category_id`, `sub_category_id` or `market_id`, and throw `BadRequestException({ statusCode: 400, message: 'Some rows are invalid', errors })`.
3. Read `households.currency`.
4. `em.transactional`: one `findOrCreate` per distinct `lower(market_name)`, keeping the first spelling; persist the bills and lines; flush.
5. Catch `UniqueConstraintViolationException` whose `constraint` is `BILLS_CLIENT_BATCH_UNIQUE`, then answer with the replay.
6. After commit, call `ensureDays` once, inside try/catch with a warning log, as `BillCrudService.warmRate` does.
7. Build the body with `toBillResponse` plus `forBills`, in the same spread order as `BillCrudService.createBill`.

- [ ] **Step 1: Write the failing int-spec `manual-bill-batch.int-spec.ts`.** Use the harness of `bill-list-order.int-spec.ts`: two households (EUR, with categories and sub-categories), a service factory on a fresh fork, and `StubProvider` rates.
  - `creates one confirmed manual bill per row`: 10 rows give `created: true`, 10 bills in row order with `source: 'manual'`. In the database: `status = 'confirmed'`, one line each, `product_count = 1`, the expected `raw_name` (note, sub-category name, category name when there is only a category), and `client_batch_index` 0..9.
  - `defaults currency to the household's`: a row without `currency` gives `'EUR'`; a `'MDL'` row is kept as is.
  - `shows in list, dashboard and breakdown`: after a batch, `BillCrudService.listBills` returns them, `BillDashboardService` totals include them, and `SpendingBreakdownService` puts a category-only row under its category, not under `UNCATEGORIZED_NAME`.
  - `rejects the batch on a bad row and saves nothing`: row 2 has the other household's category, giving 400 with `errors` equal to `[{ index: 2, field: 'category_id', message: expect.any(String) }]`. No bill with this key exists, and no market was created from `market_name` in row 0.
  - `reports every bad row`: rows 1 and 3 are bad, so `errors.map(e => e.index)` is `[1, 3]`.
  - `rejects a sub-category of another category`: `field: 'sub_category_id'`.
  - `rejects another household's or a deleted market`: `field: 'market_id'`.
  - `replays a used key`: the second call returns `created: false` and the same ids. The row count did not change.
  - `does not bring back a deleted bill on replay`: soft-delete bill 0, replay, and the response still has 3 bills with the same ids. Bill 0 still has `deleted_at` set.
  - `replays after a category is deleted`: soft-delete the category, replay, get `created: false` with no error.
  - `answers both of two concurrent identical submits with one set of bills`: run `Promise.all` on two services built from separate forks. One call has `created: true` and the other `false`, the ids are equal, and the household has exactly N bills.
  - `scopes the key to the household`: the same `client_batch_id` in household B creates new bills.
  - `uses one market for names differing in case`: rows `'Kiosk'` and `'kiosk'` share one `market.id`. A deleted market named `'Kiosk'` is not reused.
  - `lets a photo draft find the manual bill`: create a manual bill (date D, 12.50, market M), then `createDraftFromParsed` with the same date, amount and market. `BillDuplicatesService.findCandidates` on the draft probe includes the manual bill's id.
- [ ] **Step 2: Run `npm run test:e2e -- manual-bill-batch`.** Expected: FAIL, the service does not exist.
- [ ] **Step 3: Implement `ManualBillBatchService`, register it in `BillModule`.**
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(bill): save a batch of manual expenses in one call`.

### Task 7: Endpoint `POST bills/manual-batch`

**Files:**
- Modify: `src/modules/bill/bill.controller.ts` (new method, declared before `@Get(':id')` and the other `:id` routes)
- Modify: `src/modules/bill/dto/api-responses.decorator.ts` (`ApiManualBatchResponses`: 201 and 200 with `ManualBatchResponseDto`, 400 with `ManualBatchErrorResponseDto`, 401/403/429)
- Test: `src/modules/bill/bill.controller.spec.ts`

**Interfaces:**
- Consumes: `ManualBillBatchService.createBatch`.
- Produces: `createManualBatch(user, ctx, dto, @Res({ passthrough: true }) res): Promise<ManualBatchResponseDto>`, which sets `res.status(created ? 201 : 200)`. Decorated with `@Post('manual-batch')`, `@Throttle({ default: { limit: 20, ttl: 60_000 } })`, `@ApiOperation({ summary: 'Save several manual expenses at once, one bill per row' })`.

- [ ] **Step 1: Write failing controller tests**, following the existing `bill.controller.spec.ts` setup with the service mocked.
  - `created: true` gives status 201 and the body passes through.
  - `created: false` gives status 200.
  - The `ValidationPipe` (as configured in that spec) rejects `{ rows: [] }` with a message containing `rows`.
- [ ] **Step 2: Run `npm run test -- bill.controller`.** Expected: FAIL.
- [ ] **Step 3: Implement the method and the Swagger decorator, and inject the service.**
- [ ] **Step 4: Run `npm run test -- bill.controller`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(bill): expose the manual expense batch endpoint`.

### Task 8: `GET categories/recent`

**Files:**
- Create: `src/modules/category/dto/recent-categories.dto.ts`
- Modify: `src/modules/category/category.service.ts`, `src/modules/category/category.controller.ts` (route declared before `@Get(':id')`)
- Test: `src/modules/category/recent-categories.int-spec.ts`

**Interfaces:**
- Produces:
  - `RecentCategoriesQueryDto { limit?: number }` (`@Type(() => Number) @IsInt() @Min(1) @Max(50)`, default 10);
  - `RecentCategoryDto { category: { id; name }; sub_category: { id; name } | null; last_used_at: string }` (the `YYYY-MM-DD` of the newest bill);
  - `CategoryService.getRecentCategories(householdId: string, limit: number): Promise<RecentCategoryDto[]>`.
- SQL: group lines by `(l.category_id, l.sub_category_id)` over confirmed, non-deleted bills of the household with `bill_date >= current_date - 90`. Join live categories, and live sub-categories when one is set. Order by `max(b.bill_date) desc, max(b.created_at) desc`, then `limit`.

- [ ] **Step 1: Write the failing int-spec.**
  - Order: newest use first. The pair (category, null) and (category, sub) count as separate rows.
  - `limit` 2 gives 2 rows.
  - A deleted category and a deleted sub-category are absent.
  - Draft and deleted bills don't count, and neither does a bill older than 90 days.
  - Another household's bills don't count.
- [ ] **Step 2: Run `npm run test:e2e -- recent-categories`.** Expected: FAIL.
- [ ] **Step 3: Implement the DTOs, the service method and the controller route** (`@ApiOperation({ summary: 'Categories used recently, newest first' })`).
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(category): list recently used categories`.

### Task 9: Verify, PR, Linear

- [ ] **Step 1: Run `npm run lint:check`, `npm run build`, `npm run migration:check`, `npm run test`, `npm run test:e2e`.** Expected: all pass. Quote any failure verbatim.
- [ ] **Step 2: Push and open the PR into `dev`** titled `feat(bill): manual expense batch and recent categories`, with `Fixes HAN-48` and the spec link in the body. Move HAN-48 to In Review with the PR link.
- [ ] **Step 3: Comment on HAN-41** that bank import matching must also consider `source = manual` bills, with a link to the spec.
