# HAN-24 Category Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `Budget`/`PlaningHorizon` with versioned per-category spending limits (`category_limits`) and their CRUD under `/households/:hid/category-limits`.

**Architecture:** Version math is a pure function `planLimitChange` (no DB) over calendar period helpers. `CategoryLimitService` runs every write in one transaction that locks the category row `FOR UPDATE`, reads the versions still in force, applies the plan. Category soft-delete reuses the same write path to close the limit. One migration drops the legacy tables (refusing when they hold rows) and creates the new one.

**Tech Stack:** NestJS 11, MikroORM 7 (legacy decorators, PostgreSQL), class-validator, Jest (`*.spec.ts`, `*.int-spec.ts` against a real DB, `test/*.e2e-spec.ts`).

**Spec:** `docs/superpowers/specs/2026-11-15-han-24-category-limits-design.md` — read it first; this plan does not repeat its rationale.

## Global Constraints

- Branch `feat/han-24-category-limits`; commit messages `feat(limits): … (HAN-24)` / `chore(limits): … (HAN-24)`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Period types exactly `MONTHLY | QUARTERLY | SEMI_ANNUAL | YEARLY`; native enum name `limit_period_type`.
- Calendar boundaries, half-open `[start, end)`, `YYYY-MM-DD` strings, UTC arithmetic; quarters start Jan/Apr/Jul/Oct, halves Jan/Jul.
- `today` = `todayIsoDate(now)` (`src/common/utils/calendar-date.ts`); every service method takes an optional `now: Date = new Date()` for tests.
- `amount`: number, `> 0`, `<= MAX_MONEY_AMOUNT` (`src/common/utils/money.util.ts`), at most 2 decimals; DB `decimal(19,2)`, `CHECK (amount > 0)`.
- Limit currency = household currency at write time; never accepted from the client.
- Other modules import a module only through its `index.ts` barrel (dependency-cruiser, `npm run arch`).
- Any household member may write limits (`JwtAuthGuard, HouseholdMemberGuard`), no role check.
- `npm run verify` must pass at the end of every task; `npm run migration:check` and `npm run migration:drift` clean from Task 3 on.

## Review Focus

1. **Two concurrent writes to one category** (double-click, two members) → exactly one open version, no overlap. Test in Task 4 (`parallel POST`) and Task 4 (`parallel PUT`).
2. **Change on the first or last day of a period** (Nov 1, Nov 30, Dec 31 → Jan 1 for YEARLY/SEMI_ANNUAL) → S/E fall on the right side. Unit tests in Task 1 and Task 2.
3. **Household currency changed, then limit edited** → new version in the new currency, old versions keep theirs. Test in Task 4.
4. **Writing a limit for a deleted category or a category of another household** → 404, nothing written. Test in Task 4.
5. **Category deleted while it has a limit that is already closing (deleted earlier)** → nothing changes, no error. Test in Task 6.

---

### Task 1: Limit period type and calendar boundaries

**Files:**
- Create: `src/types/limit-period-type.enum.ts`
- Modify: `src/common/utils/period-range.ts` (add two exported functions)
- Test: `src/common/utils/period-range.spec.ts` (add a `describe('limit periods')`)

**Interfaces:**
- Produces: `enum LimitPeriodType { MONTHLY = 'MONTHLY', QUARTERLY = 'QUARTERLY', SEMI_ANNUAL = 'SEMI_ANNUAL', YEARLY = 'YEARLY' }`
- Produces: `limitPeriodStart(type: LimitPeriodType, date: string): string` — first day of the period containing `date`.
- Produces: `limitPeriodEnd(type: LimitPeriodType, date: string): string` — first day of the *next* period.

- [ ] **Step 1: Write the failing tests** — `it.each` over `[type, date, start, end]`:

```ts
[
  ['MONTHLY',     '2026-11-15', '2026-11-01', '2026-12-01'],
  ['MONTHLY',     '2026-12-31', '2026-12-01', '2027-01-01'],
  ['MONTHLY',     '2028-02-29', '2028-02-01', '2028-03-01'],
  ['QUARTERLY',   '2026-11-15', '2026-10-01', '2027-01-01'],
  ['QUARTERLY',   '2026-04-01', '2026-04-01', '2026-07-01'],
  ['QUARTERLY',   '2026-03-31', '2026-01-01', '2026-04-01'],
  ['SEMI_ANNUAL', '2026-06-30', '2026-01-01', '2026-07-01'],
  ['SEMI_ANNUAL', '2026-07-01', '2026-07-01', '2027-01-01'],
  ['YEARLY',      '2026-01-01', '2026-01-01', '2027-01-01'],
  ['YEARLY',      '2026-12-31', '2026-01-01', '2027-01-01'],
]
// expect(limitPeriodStart(type, date)).toBe(start); expect(limitPeriodEnd(type, date)).toBe(end)
```

- [ ] **Step 2: Run** `npm test -- src/common/utils/period-range.spec.ts` — Expected: FAIL (`limitPeriodStart` is not exported).
- [ ] **Step 3: Implement** both functions with the file's existing `parse`/`monthStart` helpers (months per type: 1/3/6/12; start month = `floor((m-1)/n)*n+1`).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(limits): calendar boundaries for limit periods (HAN-24)`.

---

### Task 2: Version planning — `planLimitChange`

**Files:**
- Create: `src/modules/category-limit/limit-versions.ts`
- Test: `src/modules/category-limit/limit-versions.spec.ts`

**Interfaces:**
- Consumes: `LimitPeriodType`, `limitPeriodStart`, `limitPeriodEnd` (Task 1); `Currency` (`src/types/currency.enum.ts`).
- Produces:

```ts
export interface LimitVersion {
  id: string;
  period_type: LimitPeriodType;
  amount: number;
  currency: Currency;
  effective_from: string;
  effective_to: string | null;
}
export type LimitChange =
  | { kind: 'set'; period_type: LimitPeriodType; amount: number; currency: Currency }
  | { kind: 'remove' };
export interface LimitPlan {
  delete: string[];
  update: { id: string; effective_to: string }[];
  insert: Omit<LimitVersion, 'id'> | null;
  /** Nothing to write: a `set` equal to the open version starting at S. */
  unchanged: boolean;
}
/** `versions`: the category's versions with effective_to null or > the change's start; older ones are history and are ignored. */
export function planLimitChange(versions: LimitVersion[], change: LimitChange, today: string): LimitPlan;
```

Rules (spec, «Правила изменения»):
- `set`: `S = limitPeriodStart(change.period_type, today)`. If the open version (`effective_to === null`) has the same `period_type`, `amount`, `currency` and `effective_from === S` → `{ unchanged: true }`, empty lists. Otherwise: every version with `effective_from >= S` → `delete`; the version with `effective_from < S` and (`effective_to === null` or `> S`) → `update` to `S`; `insert` `{…change, effective_from: S, effective_to: null}`.
- `remove`: open version absent → empty plan (`unchanged: true`). Else `E = limitPeriodEnd(open.period_type, today)`; `update` it to `E`; no insert.

- [ ] **Step 1: Write the failing tests** (`today = '2026-11-15'` unless stated; versions built with a small `v(id, type, amount, from, to)` helper, currency `'EUR'`):
  - `set on an empty category` → `insert {MONTHLY, 400, EUR, '2026-11-01', null}`, no delete/update.
  - `amount change in a later period`: `[v('a', MONTHLY, 300, '2026-09-01', null)]`, set MONTHLY 350 → `update [{id:'a', effective_to:'2026-11-01'}]`, insert from `'2026-11-01'`.
  - `second change in the same period`: `[v('a', MONTHLY, 300, '2026-11-01', null)]`, set MONTHLY 350 → `delete ['a']`, insert from `'2026-11-01'`.
  - `month → quarter (spec example)`: `[v('a', MONTHLY, 300, '2026-09-01', '2026-11-01'), v('b', MONTHLY, 350, '2026-11-01', null)]`, set QUARTERLY 1000 → `delete ['b']`, `update [{id:'a', effective_to:'2026-10-01'}]`, insert QUARTERLY from `'2026-10-01'`.
  - `quarter → month`: `[v('q', QUARTERLY, 1000, '2026-07-01', null)]`, set MONTHLY 400 → `update [{id:'q', effective_to:'2026-11-01'}]`, insert from `'2026-11-01'`.
  - `month → year rewrites the whole year`: `[v('a', MONTHLY, 300, '2026-01-01', '2026-06-01'), v('b', MONTHLY, 350, '2026-06-01', null)]`, set YEARLY 5000 → `delete ['a','b']`, insert from `'2026-01-01'`.
  - `idempotent set`: `[v('a', MONTHLY, 400, '2026-11-01', null)]`, set MONTHLY 400 EUR → `unchanged: true`, all lists empty, `insert: null`.
  - `same amount, other currency is a change`: same as above but set currency `'MDL'` → `delete ['a']`, insert MDL.
  - `remove keeps the limit to the end of its period`: `[v('a', QUARTERLY, 1000, '2026-10-01', null)]`, remove → `update [{id:'a', effective_to:'2027-01-01'}]`.
  - `remove without an open version` → `unchanged: true`.
  - `set after remove in the same period`: `[v('a', MONTHLY, 300, '2026-09-01', '2026-12-01')]`, set MONTHLY 500 → `update [{id:'a', effective_to:'2026-11-01'}]`, insert from `'2026-11-01'`.
  - `set after remove, closed version started this period`: `[v('a', MONTHLY, 300, '2026-11-01', '2026-12-01')]`, set MONTHLY 500 → `delete ['a']`.
  - `first day of the period`: today `'2026-11-01'`, `[v('a', MONTHLY, 300, '2026-10-01', null)]`, set 350 → `update` to `'2026-11-01'`.
  - **Property test** `no overlaps after any sequence`: deterministic PRNG (seeded LCG, 500 runs × 1–8 random changes of random kind/type/amount on random days walking forward through 2026–2028); apply each plan to an in-memory list (history = versions with `effective_to <= S` kept aside); assert after every step: at most one `effective_to === null`; sorted by `effective_from`, each `effective_to` (non-null) `<=` next `effective_from`; every `effective_from === limitPeriodStart(own type, effective_from)`; every `effective_to`, if set, `> effective_from`.
- [ ] **Step 2: Run** `npm test -- src/modules/category-limit/limit-versions.spec.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `planLimitChange` per the rules above.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(limits): plan limit version changes (HAN-24)`.

---

### Task 3: Schema — drop Budget/PlaningHorizon, add `category_limits`

**Files:**
- Delete: `src/modules/budget/**`, `src/modules/planing-horizon/**`, `src/entities/budget.entity.ts`, `src/entities/planing-horizon.entity.ts`, `src/entities/planing-horizon-category.entity.ts`, `src/types/period-type.enum.ts`
- Create: `src/entities/category-limit.entity.ts`, `src/migrations/Migration20261115120000_ReplaceBudgetsWithCategoryLimits.ts`, `test/category-limits-migration.int-spec.ts`
- Modify: `src/app.module.ts` (drop `BudgetModule`, `PlaningHorizonModule`), `src/entities/category.entity.ts` (drop `planingHorizons`), `src/modules/category/category.module.ts` (drop `PlaningHorizon` from `forFeature`), `src/modules/category/category.service.ts` (drop horizon lookup/link in `createCategory`, `bulkCreateCategories`, the repository injection), `src/modules/category/dto/create-category.dto.ts` and `dto/bulk-create-category.dto.ts` (drop `planing_horizon_id`), `src/modules/bill/dto/money-bounds.dto.spec.ts` (drop horizon cases)
- Modify tests that create budgets/horizons: `test/household-isolation.e2e-spec.ts`, `test/name-uniqueness.e2e-spec.ts` (drop the horizon-name cases; keep category ones), `test/uuid-params.e2e-spec.ts`, `test/bill-date-format.e2e-spec.ts`, `test/household-currency.e2e-spec.ts`, `test/dedupe-personal-households.int-spec.ts` (no `budgets` rows), plus whatever `grep -rn "budget\|planing\|horizon" src test scripts` still finds (ignore `AiBudget…` and old migrations).

**Interfaces:**
- Produces entity `CategoryLimit` (table `category_limits`), fields exactly as the spec table: `id` (BaseEntity), `household: Rel<Household>` (`household_id`, cascade), `category: Rel<Category>` (`category_id`, cascade), `period_type: LimitPeriodType` (`nativeEnumName: 'limit_period_type'`), `amount: number` (`decimal(19,2)`), `currency: Currency` (`nativeEnumName: 'currency_enum'`), `effective_from: string` (`type: 'date'`), `effective_to: string | null` (`type: 'date'`, nullable), `created_by: Rel<User> | null` (`created_by_id`, `on delete set null`), `created_at`, `updated_at` (`timestamptz`, hooks like `Category`).
- Indexes/constraints named: `category_limits_category_open_unique` (partial unique, `expression` like `categories_household_id_name_lower_unique`), `category_limits_household_category_from_index` on `(household_id, category_id, effective_from)`, checks `category_limits_amount_positive`, `category_limits_effective_range` (declare with `@Check` so the snapshot matches).

- [ ] **Step 1: Write the failing migration test** `test/category-limits-migration.int-spec.ts`:
  - `creates category_limits with its constraints`: `information_schema`/`pg_constraint` shows the table, both checks and the partial unique index; inserting two open rows for one category fails with code `23505`; `amount = 0` fails with `23514`; `effective_to = effective_from` fails with `23514`.
  - `refuses to drop non-empty legacy tables`: run `down()` of the new migration, insert a `budgets` row, run `up()` → rejects with a message containing `export them before HAN-24 migration`; clean up, run `up()` again → succeeds. (Run the migration class methods through `orm.migrator` `down({ to: … })`/`up()` or by executing its SQL — pick whichever the migrator API allows; the assertion is what matters.)
- [ ] **Step 2: Run** `npm test -- test/category-limits-migration.int-spec.ts` — Expected: FAIL (table does not exist).
- [ ] **Step 3: Remove the legacy code** listed under Files and fix every compile error and test listed (category create endpoints now accept `{name, description?}` only).
- [ ] **Step 4: Add the entity and write the migration.** `up`: a `DO $$ … $$` block that `RAISE EXCEPTION 'budgets/planing_horizons: % rows found, export them before HAN-24 migration', n` when `budgets` + `planing_horizons` + `planing_horizon_categories` hold any row; then `drop table planing_horizon_categories, planing_horizons, budgets`; `drop type period_type_enum`; `create type limit_period_type as enum (…)`; create table, FKs, checks, indexes. `down`: drop `category_limits` and `limit_period_type`, recreate the legacy schema as the last migrations left it — copy DDL from `Migration20251224124554_CreateBudgetTable`, `…124555_CreatePlaningHorizonTable`, `…125425_AddBudgetForeignKeyToPlaningHorizon`, `…130033_CreatePlaningHorizonCategoriesJoinTable`, `Migration20251230141421_AddUserIdToBudgets`, `Migration20260112190035_AddIsArchivedToPlaningHorizons`, the budget/horizon parts of `Migration20260603130000_MigrateOwnershipToHouseholds` and `Migration20261011150000_AddNameUniqueIndexes`. Generate a draft with `npm run migration:create` to see what MikroORM expects for the new table, then hand-edit.
- [ ] **Step 5: Run** `npm run migration:up && npm run migration:down && npm run migration:up && npm run migration:check && npm run migration:drift` — Expected: all succeed, drift reports none.
- [ ] **Step 6: Run** `npm test -- test/category-limits-migration.int-spec.ts` then `npm run verify` and `npm run test:e2e` — Expected: PASS.
- [ ] **Step 7: Commit** `feat(limits): replace budgets and planning horizons with category_limits (HAN-24)`.

---

### Task 4: `CategoryLimitService`

**Files:**
- Create: `src/modules/category-limit/category-limit.service.ts`, `src/modules/category-limit/category-limit-write.ts`, `src/modules/category-limit/dto/category-limit.dto.ts`, `src/modules/category-limit/index.ts`
- Test: `src/modules/category-limit/category-limit.int-spec.ts` (set up households/users/categories with raw SQL like `src/modules/bill/bill-move.int-spec.ts`)

**Interfaces:**
- Consumes: `planLimitChange`, `LimitVersion`, `LimitChange` (Task 2); `CategoryLimit` entity (Task 3).
- Produces in `category-limit-write.ts` (exported through `index.ts`, used by Task 6 without Nest DI):

```ts
/** Locks the category row (FOR UPDATE), plans and applies `change`. Must run inside `tx`'s transaction. Returns the version in force today after the write, or null. */
export async function writeCategoryLimit(
  tx: EntityManager, householdId: string, categoryId: string,
  change: LimitChange, opts: { userId: string | null; today: string; requireOpen?: boolean; forbidOpen?: boolean },
): Promise<CategoryLimit | null>;
```
  - Locks `categories` where `id`, `household_id`, `deleted_at IS NULL` — none → `NotFoundException`. (Task 6 calls it before setting `deleted_at`, so the category is still live.)
  - `forbidOpen` and an open version exists → `ConflictException`; `requireOpen` and none → `NotFoundException`.
  - Loads the category's versions with `effective_to IS NULL OR effective_to > limitPeriodStart(YEARLY, today)` — the earliest S any type can produce, so every version a plan may touch is loaded.
  - For `set`, the currency comes from `households.currency` read in the same transaction.
- Produces `CategoryLimitDto` (spec «API»): `id, category_id, category_name, category_archived, period_type, amount, currency, effective_from, effective_to` with `@ApiProperty` on each; `CreateCategoryLimitDto { category_id: uuid; period_type: LimitPeriodType; amount: number }`, `UpdateCategoryLimitDto { period_type; amount }` — `@IsUUID()`, `@IsEnum(LimitPeriodType)`, `@IsNumber({ maxDecimalPlaces: 2 })`, `@IsPositive()`, `@Max(MAX_MONEY_AMOUNT)`.
- Produces `CategoryLimitService` (`@Injectable`, `EntityManager`):
  - `list(householdId: string, includeHistory: boolean, now = new Date()): Promise<CategoryLimitDto[]>` — without history: versions in force today (`effective_from <= today AND (effective_to IS NULL OR effective_to > today)`), ordered by category name; with history: all, ordered by `category_id, effective_from`.
  - `create(householdId, userId, dto: CreateCategoryLimitDto, now?)` → `writeCategoryLimit(…, {kind:'set', …}, { forbidOpen: true })`.
  - `update(householdId, userId, categoryId, dto: UpdateCategoryLimitDto, now?)` → `{ requireOpen: true }`.
  - `remove(householdId, categoryId, now?)` → `{kind:'remove'}`, `{ requireOpen: true }`; returns the closed version.
  - Each runs `this.em.fork().transactional(...)`.

- [ ] **Step 1: Write the failing int tests** (fixed `now = new Date('2026-11-15T10:00:00Z')` unless stated):
  - `create → version from 2026-11-01 in household currency (EUR)`.
  - `second create while open → ConflictException`.
  - `update in a later month closes the old version` (create with now 2026-10-10, update with now 2026-11-15) → history has `[2026-10-01, 2026-11-01)` and `[2026-11-01, null)`.
  - `update twice in a month keeps one version per start`.
  - `month → quarter rewrites October` (spec example through the service).
  - `update with same values is a no-op` (same `id` returned, `updated_at` unchanged).
  - `remove sets effective_to to next period start; list still shows it until then; list with now 2026-12-01 does not`.
  - `create after remove in the same month → 201-equivalent, one open version from 2026-11-01`.
  - `update or remove without an open limit → NotFoundException` (including a closing one).
  - `category of another household / deleted category → NotFoundException, nothing written`.
  - `household currency changed: next update writes MDL, old version stays EUR` (Review Focus 3).
  - `parallel create → one fulfilled, one ConflictException, one open row` (`Promise.allSettled` of two `create`).
  - `parallel update → exactly one open row, no overlapping versions` (Review Focus 1).
- [ ] **Step 2: Run** `npm test -- src/modules/category-limit/category-limit.int-spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `writeCategoryLimit`, DTOs and `CategoryLimitService`; lock with `tx.findOne(Category, …, { lockMode: LockMode.PESSIMISTIC_WRITE })` as in `bill-duplicates.service.ts`; apply plan as delete → update → insert in that order (partial unique stays valid).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(limits): category limit service with locked version writes (HAN-24)`.

---

### Task 5: Controller, module, Swagger, e2e

**Files:**
- Create: `src/modules/category-limit/category-limit.controller.ts`, `src/modules/category-limit/category-limit.module.ts`, `src/modules/category-limit/decorators/api-responses.decorator.ts`, `test/category-limits.e2e-spec.ts`
- Modify: `src/app.module.ts` (register `CategoryLimitModule`), `test/household-isolation.e2e-spec.ts` (add category-limits to foreign-household and foreign-record cases), `test/uuid-params.e2e-spec.ts` (`put`/`delete` `category-limits/abc` → 400)

**Interfaces:**
- Consumes: `CategoryLimitService`, DTOs (Task 4).
- Produces routes (`@Controller('households/:hid/category-limits')`, `@UseGuards(JwtAuthGuard, HouseholdMemberGuard)`, `@ApiTags('category-limits')`, `@ApiBearerAuth('JWT-auth')`):
  - `GET /` `?include_history=true|false` (boolean query DTO) → 200 `CategoryLimitDto[]`
  - `POST /` → 201 | 400 | 404 | 409
  - `PUT /:categoryId` (`ParseUUIDPipe`) → 200 | 400 | 404
  - `DELETE /:categoryId` (`ParseUUIDPipe`) → 200 `CategoryLimitDto` | 404
  - `userId` from `@CurrentUser()` (`src/modules/auth`), `householdId` from `@CurrentHousehold()`.

- [ ] **Step 1: Write the failing e2e test** `test/category-limits.e2e-spec.ts` (pattern: `test/household-currency.e2e-spec.ts`, `createTestApp`, `registerUser`): POST → 201 body matches `CategoryLimitDto` with `effective_to: null`; POST again → 409; POST `amount: 0` → 400, `amount: 1.005` → 400, `period_type: 'WEEKLY'` → 400, `currency` in body rejected (whitelist) → 400; PUT → 200 with new amount; GET `?include_history=true` → 2 versions; DELETE → 200 with `effective_to` = first day of next month (compute from today in the test); PUT after DELETE → 404; non-member hid → 403.
- [ ] **Step 2: Run** `npm run test:e2e -- test/category-limits.e2e-spec.ts` — Expected: FAIL (404 route).
- [ ] **Step 3: Implement** controller, module (`MikroOrmModule.forFeature([CategoryLimit, Category])`), Swagger response decorators following `src/modules/category/decorators/api-responses.decorator.ts`; register in `app.module.ts`; extend isolation and uuid-params tests.
- [ ] **Step 4: Run** `npm run test:e2e -- test/category-limits.e2e-spec.ts test/household-isolation.e2e-spec.ts test/uuid-params.e2e-spec.ts` — Expected: PASS. Open `/api` Swagger locally (or the generated JSON in tests if present) and check the four operations appear and budgets/planing-horizons are gone.
- [ ] **Step 5: Commit** `feat(limits): category-limits endpoints (HAN-24)`.

---

### Task 6: Deleting a category closes its limit

**Files:**
- Modify: `src/modules/category/category.service.ts` (`deleteCategory`)
- Test: `src/modules/category/soft-delete-consistency.int-spec.ts` (add cases) or a new `src/modules/category/category-delete-limit.int-spec.ts`

**Interfaces:**
- Consumes: `writeCategoryLimit` from `src/modules/category-limit` barrel (Task 4) with `{ kind: 'remove' }`, `{ userId: null, today }` (no `requireOpen`: no limit is fine) — call it *before* setting `deleted_at`, in the same transaction.

- [ ] **Step 1: Write the failing tests:** `deleting a category with an open MONTHLY limit closes it at 2026-12-01` (now 2026-11-15); `deleting a category whose limit is already closing changes nothing` (Review Focus 5); `deleting a category without a limit still works`; sub-categories still soft-deleted as before.
- [ ] **Step 2: Run** the test file — Expected: FAIL (limit stays open).
- [ ] **Step 3: Implement:** wrap `deleteCategory` in `this.em.fork().transactional`, call `writeCategoryLimit` (it takes the row lock), then soft-delete as today. Keep the 404/400 behaviour. Add `now: Date = new Date()` parameter.
- [ ] **Step 4: Run** the test file and `npm run arch` — Expected: PASS, no new dependency-cruiser violations (category → category-limit barrel; category-limit must not import the category module, only the `Category` entity).
- [ ] **Step 5: Commit** `feat(limits): close a category's limit when the category is deleted (HAN-24)`.

---

### Task 7: Final verification

- [ ] **Step 1: Run** `npm run verify` — Expected: type-check, lint, arch, dup, knip, unit+int tests all pass (knip: no leftover exports from removed modules).
- [ ] **Step 2: Run** `npm run test:e2e` — Expected: PASS.
- [ ] **Step 3: Run** `npm run migration:down && npm run migration:up && npm run migration:check && npm run migration:drift` — Expected: clean.
- [ ] **Step 4:** `grep -rn "planing\|PlaningHorizon\|BudgetModule\|period_type_enum" src test scripts --include=*.ts | grep -v src/migrations/` — Expected: no output.
