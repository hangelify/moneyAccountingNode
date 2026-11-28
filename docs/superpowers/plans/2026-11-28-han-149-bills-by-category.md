# HAN-149 Bills by Category Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a limits-report row, open the confirmed-bills list filtered to that category and period, showing each bill's category contribution and a category total equal to the report's `spent`.

**Architecture:** Server: new `GET /households/:hid/bills/by-category/:categoryId` reusing `ListBillsQueryDto` and a `WHERE` builder / row mapper extracted from `BillCrudService.listBills`; contribution and total are computed in SQL with the same conversion and rounding as `fetchSpent`. Front: `category_id` lives in the list URL; `useConfirmedBills` switches endpoint when it is set; the list shows a chip, a total line and a per-row "of which" line; `LimitReportRow` links to the list.

**Tech Stack:** NestJS 11 + MikroORM (raw SQL via `em.getConnection().execute`), Jest int/e2e specs on PostgreSQL; React + react-router + TanStack Query + i18next, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-28-han-149-bills-by-category-design.md`

## Global Constraints

- Server branch `feat/han-149-bills-by-category` (exists, from dev e494b9c); front branch `enh/han-149-bills-by-category` from `dev` **after HAN-148 is merged**.
- `GET /bills` behaviour and response must not change.
- Amounts in the API are numbers (`numberOrNull`), like `household_amount`.
- Contribution and total use `householdConversionJoin('b')` and `fx.factor`; total = sum over `(category_id, sub_category_id)` groups of `ROUND(SUM(l.amount * fx.factor), 2)` — identical to `fetchSpent`.
- Archived (soft-deleted) categories of the household are valid; a category of another household or unknown id → 404.
- Report link: `date_from = start`, `date_to = end − 1 day`, never `include_duplicates`.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Server gate: `npm run verify` + `npm run test:e2e`; front gate: `npm run verify`.

## Review Focus

1. A bill in a foreign currency with no rate: `category_amount` is `null`, it is excluded from `category_total`, counted in `unconverted_lines`; the page shows `UnconvertedNote` (Task 2, Task 5).
2. A malformed `category_id` in the URL is ignored on the front (plain list, no chip, no request to `by-category`) (Task 4).
3. Removing the chip keeps every other filter and resets to page 1 (Task 5).
4. `by-category` is not swallowed by `@Get(':id')` (Task 3 e2e).
5. Report link for a quarter ends on the last day of the quarter, not the first day of the next (Task 6).

---

## Part 1 — Server (`accounting_node/accounting`)

### Task 1: Extract the list `WHERE` builder and row mapper

**Files:**
- Modify: `src/modules/bill/bill-crud.service.ts:218-362` (`listBills`)
- Test: `src/modules/bill/bill-queries.int-spec.ts` (existing, unchanged)

**Interfaces:**
- Produces (private, same file):
  - `listWhere(householdId: string, filters: ListBillsQueryDto): { where: string; params: unknown[] }` — throws the existing 400 when `date_from > date_to`; contains every current condition.
  - `type ListRow` — the current row type of the data query.
  - `toListItem(r: ListRow): BillListItemDto` — the current `dataRows.map` body.

- [ ] **Step 1:** Move the code into the three helpers; `listBills` calls them. No behaviour change.
- [ ] **Step 2:** Run `npx jest src/modules/bill/bill-queries.int-spec.ts src/modules/bill` — Expected: all PASS.
- [ ] **Step 3:** Commit `refactor(bills): extract list where-builder and row mapper (HAN-149)`.

### Task 2: `listBillsByCategory` service method and DTOs

**Files:**
- Create: `src/modules/bill/dto/bills-by-category-response.dto.ts`
- Modify: `src/modules/bill/bill-crud.service.ts`
- Test (create): `src/modules/bill/bill-by-category.int-spec.ts` (setup copied from `bill-queries.int-spec.ts`)
- Test (create): `src/modules/category-limit/limit-report-drilldown.int-spec.ts` (cross-check with the report; `category-limit` may import from `../bill`, not the reverse)

**Interfaces:**
- Consumes: `listWhere`, `ListRow`, `toListItem` (Task 1).
- Produces:
  - `class BillByCategoryItemDto extends BillListItemDto { category_amount!: number | null }`
  - `class BillsCategoryRefDto { id!: string; name!: string; archived!: boolean }`
  - `class BillsByCategoryResponseDto { data!: BillByCategoryItemDto[]; meta!: PaginationMetaDto; category!: BillsCategoryRefDto; category_total!: number; household_currency!: Currency; unconverted_lines!: number }` — all with `@ApiProperty` (description + example).
  - `BillCrudService.listBillsByCategory(householdId: string, categoryId: string, filters: ListBillsQueryDto): Promise<BillsByCategoryResponseDto>`

Fixture for both specs (EUR household, Food and Home categories; for `b3` use a bill currency the `StubProvider` has no rate for — see how `bill-queries.int-spec.ts` / `household-conversion.int-spec.ts` set this up):
- `b1` 2026-10-05 EUR 80.00: Food 30.00, Home 50.00
- `b2` 2026-10-20 EUR 12.34: Food 12.34
- `b3` 2026-10-21 in a currency with no stub rate: Food 10.00
- `b4` 2026-10-22 EUR 5: Home 5 (no Food line)
- `b5` 2026-11-02 EUR 7: Food 7 (outside October)
- `b6` 2026-10-23 EUR 9: Food 9, `status = duplicate`
- `b7` 2026-10-24 EUR 4: Food 4, `deleted_at` set

- [ ] **Step 1: Write the failing tests** in `bill-by-category.int-spec.ts`:
  - `lists bills with a Food line, whole, with the Food contribution` — filters `{date_from:'2026-10-01', date_to:'2026-10-31'}` → ids `[b3, b2, b1]` (newest first); `b1.total_amount === 80`, `b1.category_amount === 30`; `b2.category_amount === 12.34`.
  - `a line without a rate: null contribution, out of the total, counted` — `b3.category_amount === null`; `category_total === 42.34`; `unconverted_lines === 1`.
  - `combines with other filters; total follows them` — `{..., amount_range:['gt_50']}` → ids `[b1]`, `category_total === 30`, `meta.total === 1`.
  - `excludes duplicates by default and includes them with include_duplicates` — default: no `b6`; `{include_duplicates:true}` → `b6` present, `category_total === 51.34`.
  - `excludes deleted bills` — `b7` never present.
  - `paginates; the total covers every page` — `{limit:1, page:2}` → `data.length === 1`, `meta.total === 3`, `category_total === 42.34`.
  - `an archived category still lists its bills` — soft-delete Food, `category.archived === true`, ids unchanged.
  - `another household's category → NotFoundException`; `unknown uuid → NotFoundException`.
  - `returns the category ref and household currency` — `category === {id, name:'Food', archived:false}`, `household_currency === 'EUR'`.
- [ ] **Step 2:** Run `npx jest src/modules/bill/bill-by-category.int-spec.ts` — Expected: FAIL (`listBillsByCategory` is not a function).
- [ ] **Step 3: Implement** the DTOs and `listBillsByCategory`:
  - category lookup: `SELECT id, name, deleted_at IS NOT NULL AS archived FROM categories WHERE id = ? AND household_id = ?` → none → `NotFoundException('Category not found')`.
  - `where` from `listWhere` + `AND EXISTS (SELECT 1 FROM bill_sub_categories c WHERE c.bill_id = b.id AND c.category_id = ?)`.
  - data query: the list query plus a lateral `ROUND(SUM(l.amount) FILTER (WHERE l.category_id = ?) * fx.factor, 2)` — or `ROUND(SUM(l.amount * fx.factor) FILTER (...), 2)`; either is exact per bill since `fx.factor` is per bill. Map with `toListItem` + `category_amount: numberOrNull(...)`.
  - count query: as in `listBills`.
  - total query (same `where`): sum over `GROUP BY l.category_id, l.sub_category_id` of `ROUND(SUM(l.amount * fx.factor), 2)` restricted to `l.category_id = ?`, plus `COUNT(*) FILTER (WHERE fx.factor IS NULL)`; `COALESCE(…, 0)`.
  - `household_currency` from the households row (as `readCurrency` does).
- [ ] **Step 4:** Run the spec — Expected: PASS.
- [ ] **Step 5: Write the cross-check** in `limit-report-drilldown.int-spec.ts` (setup like `limit-report.int-spec.ts`, plus `BillCrudService` and its providers): Food monthly limit 100 from 2026-10-01; bills `b1`, `b2`, `b3` (no-rate) and a USD bill with a stub rate and lines Food 3.33 + Food/other-sub 1.11 on 2026-10-10.
  - `category_total equals the report's spent for the period` — `report(hid, MONTHLY, '2026-10-15')` row Food `.spent` `===` `listBillsByCategory(hid, food, {date_from: r.start, date_to: addDays(r.end, -1)}).category_total`; `unconverted_lines` equal to the row's.
- [ ] **Step 6:** Run `npx jest src/modules/category-limit/limit-report-drilldown.int-spec.ts` — Expected: PASS. Run `npm run arch` — Expected: no new violations.
- [ ] **Step 7:** Commit `feat(bills): list bills of a category with contribution and total (HAN-149)`.

### Task 3: Controller route, Swagger, e2e

**Files:**
- Modify: `src/modules/bill/bill.controller.ts` (new handler placed **before** `@Get(':id')`, line ~441)
- Modify: `src/modules/bill/dto/api-responses.decorator.ts` (add `ApiBillsByCategoryResponses`)
- Test (create): `test/bills-by-category.e2e-spec.ts` (pattern: `test/spending-breakdown.e2e-spec.ts`)

**Interfaces:**
- Consumes: `listBillsByCategory`, `BillsByCategoryResponseDto` (Task 2).
- Produces: `GET /households/:hid/bills/by-category/:categoryId` → 200 `BillsByCategoryResponseDto`; 400 invalid query / non-UUID `categoryId`; 401; 403 non-member; 404 category not in household.

- [ ] **Step 1: Write the failing e2e tests:**
  - `200: lists the category's bills with contribution and total` — register user, take a seeded category, create a confirmed bill via the existing API with two categories; `body.data[0].category_amount`, `body.category_total`, `body.category.name`.
  - `400 for a non-UUID category id`; `400 when date_from > date_to`.
  - `404 for another household's category`.
  - `403 for a non-member`; `401 without a token`.
  - `GET /bills/:id still returns a bill` (route order guard).
- [ ] **Step 2:** Run `npm run test:e2e -- bills-by-category` — Expected: FAIL (404 route).
- [ ] **Step 3: Implement** `listBillsByCategory(@CurrentUser() _user, @CurrentHousehold() ctx, @Param('categoryId', ParseUUIDPipe) categoryId: string, @Query() query: ListBillsQueryDto)` with `@Get('by-category/:categoryId')`, `@ApiOperation({ summary: "List confirmed bills with a line in the category, each with the category's contribution, and the category total for the filters" })`, `@ApiBillsByCategoryResponses()`.
- [ ] **Step 4:** Run the e2e — Expected: PASS. Run `npm run verify && npm run test:e2e` — Expected: all PASS.
- [ ] **Step 5:** Commit `feat(bills): GET /bills/by-category/:categoryId endpoint (HAN-149)`. Then PR to `dev` with `Part of HAN-149`; Linear → In Review.

## Part 2 — Front (`accounting_react`, after HAN-148 merges)

### Task 4: URL param, API client, query hook

**Files:**
- Modify: `src/api/buildBillsQueryParams.ts`, `src/api/parseBillsSearchParams.ts`, `src/hooks/useConfirmedBillsFilters.ts` (`EMPTY`), `src/api/bills.ts`, `src/const/bills.ts`, `src/types/bills.ts`, `src/hooks/useConfirmedBills.ts`
- Test: `src/api/parseBillsSearchParams.test.ts`, `src/api/buildBillsQueryParams.test.ts` (create if absent), `src/hooks/useConfirmedBillsFilters.test.tsx`, a `billsApi.listByCategory` test next to existing api tests

**Interfaces:**
- Produces:
  - `ConfirmedBillsFilters.category_id: string | null`
  - `BILLS_ENDPOINTS.BY_CATEGORY = (id: string) => \`/bills/by-category/${id}\``
  - types `BillByCategoryItem = BillResponseDto & { category_amount: number | null }`, `BillsByCategoryResponse = Paginated<BillByCategoryItem> & { category: { id: string; name: string; archived: boolean }; category_total: number; household_currency: Currency; unconverted_lines: number }`
  - `billsApi.listByCategory(hid, categoryId, filters, page, limit): Promise<BillsByCategoryResponse>` — query from `buildBillsQueryParams` without `category_id`.
  - `useConfirmedBills(...)` returns `UseQueryResult<Paginated<BillResponseDto> | BillsByCategoryResponse>`; query key unchanged shape (filters already include `category_id`).
  - `isByCategory(data): data is BillsByCategoryResponse` (exported from `src/types/bills.ts`).

- [ ] **Step 1: Write failing tests:**
  - parse: `category_id=<uuid>` → `filters.category_id === uuid`; `category_id=abc` → `null`; absent → `null`.
  - build: `{category_id: uuid}` → `out.category_id === uuid`; `null` → key absent.
  - round trip: `parse(build(f)) ` keeps `category_id`.
  - api: `listByCategory` hits `/households/h1/bills/by-category/<uuid>?date_from=…&page=1&limit=20` and the query has no `category_id`.
  - hook: with `category_id` the by-category endpoint is called, without it `/bills`.
- [ ] **Step 2:** Run `npx vitest run src/api src/hooks` — Expected: FAIL.
- [ ] **Step 3:** Implement (UUID check: reuse an existing helper if `src/lib` has one, else `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`).
- [ ] **Step 4:** Run tests — Expected: PASS.
- [ ] **Step 5:** Commit `enh(bills): category_id filter and by-category API (HAN-149)`.

### Task 5: Chip, category total, "of which" line

**Files:**
- Create: `src/pages/bills/components/CategoryFilterChip.tsx`, `src/pages/bills/components/CategoryTotal.tsx`, `src/pages/bills/components/CategoryShare.tsx` (+ `.test.tsx` each)
- Modify: `src/pages/bills/BillsListPage.tsx` (chip + total above the list; `hasActiveFilters` includes `category_id`), `src/pages/bills/components/ConfirmedBillsTable.tsx`, `src/pages/bills/components/BillCard.tsx` (render `CategoryShare` when the bill has `category_amount`), `src/locales/*/bills.json` (ru, en — follow existing locale set)

**Interfaces:**
- Consumes: `isByCategory`, `BillsByCategoryResponse` (Task 4); `UnconvertedNote` from `src/pages/dashboard/components/UnconvertedNote.tsx`; `formatAmount` from `@/lib/format`.
- Produces: `CategoryFilterChip({ name, unavailable, onRemove })`, `CategoryTotal({ name, total, currency, unconvertedLines })`, `CategoryShare({ name, amount, currency })` (`amount === null` → renders nothing).
- `renderBills` gets the category name via an optional 4th argument `category?: { name: string }` so both table and cards can show the line.

Copy (ru): chip `Категория: {{name}}`, unavailable `Категория недоступна`, remove button `aria-label="Снять фильтр категории"`; total `В категории {{name}}: {{amount}}`; row `из них {{name}} {{amount}}`. English equivalents in `en`.

- [ ] **Step 1: Write failing tests:**
  - `BillsListPage`: by-category response → chip `Категория: Еда`, total `В категории Еда: 42,34 €`, `UnconvertedNote` when `unconverted_lines > 0`, row line `из них Еда 30,00 €`.
  - removing the chip: URL loses `category_id`, keeps `date_from`/`date_to`/`market_names`, `page=1`; `/bills` endpoint is then called.
  - 404 from by-category → chip `Категория недоступна`, empty state, no error toast.
  - `CategoryShare` with `amount: null` renders nothing.
- [ ] **Step 2:** Run `npx vitest run src/pages/bills` — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests — Expected: PASS.
- [ ] **Step 5:** Commit `enh(bills): category chip, total and contribution in the list (HAN-149)`.

### Task 6: Link from the limits report

**Files:**
- Modify: `src/pages/dashboard/limits/LimitReportRow.tsx` (optional `href?: string`; when set the name is a `<Link>`), `src/pages/dashboard/limits/LimitsReportTab.tsx` (pass `href` for category rows only — not the total row, not "other")
- Create: `src/pages/dashboard/limits/billsLink.ts` + `billsLink.test.ts`
- Test: `src/pages/dashboard/limits/LimitReportRow.test.tsx`, `LimitsReportTab.test.tsx`

**Interfaces:**
- Consumes: `addDays` from `@/lib/isoDate`; `LimitReport.start` / `.end` from `@/types/limitReport`.
- Produces: `billsLinkForCategory(categoryId: string, start: string, end: string): string` → `/bills/confirmed?category_id=<id>&date_from=<start>&date_to=<addDays(end,-1)>`.

- [ ] **Step 1: Write failing tests:**
  - `billsLinkForCategory('c1','2026-10-01','2026-11-01')` → `date_to=2026-10-31`; quarter `('c1','2026-10-01','2027-01-01')` → `date_to=2026-12-31`; no `include_duplicates`.
  - `LimitReportRow` with `href` renders a link with the category name; without `href` plain text; the total row has no link.
  - `LimitsReportTab`: each category row links to its URL; archived category rows link too.
- [ ] **Step 2:** Run `npx vitest run src/pages/dashboard/limits` — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run verify` — Expected: all PASS.
- [ ] **Step 5:** Commit `enh(limits): link report rows to the category's bills (HAN-149)`. PR to `dev` with `Fixes HAN-149`.
