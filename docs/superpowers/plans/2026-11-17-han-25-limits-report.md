# HAN-25 Limits Report and Carry-over Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /households/:hid/category-limits/report` (исполнение лимитов за календарный период с переносом остатка) и `PUT /households/:hid/category-limits/:categoryId/carry-over` (отметка «не переносить»).

**Architecture:** Перенос считается при чтении. Сервис читает версии лимитов и отметки, чистая функция строит цепочки периодов по категориям, затем один SQL-агрегат даёт траты по `(category, sub_category, bucket)` за всю цепочку, отдельный запрос — коэффициенты пересчёта базовых лимитов. Чистая свёртка `buildLimitReport` считает перенос, лимит, остаток, %, итог и `other_spent` в центах.

**Tech Stack:** NestJS 11, MikroORM 7 (PostgreSQL, raw SQL через `conn.execute`), class-validator, Jest (`*.spec.ts` — юнит, `*.int-spec.ts` — с реальной БД).

**Spec:** `docs/superpowers/specs/2026-11-17-han-25-limits-report-design.md`

## Global Constraints

- Импорт между модулями — только через barrel `src/modules/<m>/index.ts`; Nest-модуль — из `./<m>.module`.
- Деньги в свёртке — целые центы: `Math.round(Number(v) * 100)`, обратно `c / 100`.
- `percent = Math.round(spent / limit * 10000) / 100`; `null`, если `limit === null` или `limit <= 0`.
- Округление трат как в разбивке: `ROUND(SUM(l.amount * fx.factor), 2)` по `(category_id, sub_category_id, bucket)`, дальше сумма округлённых частей.
- Факт — только `b.status = 'confirmed' AND b.deleted_at IS NULL`, по `l.category_id` (не через подкатегорию).
- Курсы — правило `householdConversionJoin`: последний сохранённый не старше 7 дней, через MDL; поведение разбивки трат и дашборда не меняется.
- `today` — `todayIsoDate(now)` (UTC); у сервисов параметр `now: Date = new Date()` для тестов.
- Периоды — `limitPeriodStart/limitPeriodEnd` из `src/common/utils/period-range.ts`, half-open.
- Миграции: `set local lock_timeout = '5s'; set local statement_timeout = '60s';` в up и down; `npm run migration:check` и `npm run migration:drift` чистые.
- Перед PR: `npm run verify` зелёный.

## Review Focus

1. **Два чека в один день в разных валютах, у одного нет курса** — факт категории = только пересчитанный, `unconverted_lines = 1`, и та же строка не попадает в `other_spent` (Task 4: `counts the converted part only`).
2. **Долг больше базового лимита** (потратил 250 при 100 → лимит следующего −50) — `limit: -50`, `percent: null`, `remaining` отрицательный и накапливается дальше (Task 3: `debt larger than the limit`).
3. **Отметка «не переносить» на период вне цепочки** (лимит потом снят / тип сменён) — не ломает отчёт и не влияет на расчёт (Task 3: `ignores a stop outside the chain`).
4. **Отчёт за `date` в далёком прошлом до первого лимита** — `categories: []`, нулевой итог, `other_spent` по тратам периода, без ошибок (Task 4: `empty before the first limit`).
5. **Чужой household**: лимиты, отметки и чеки другого бюджета с той же категорией-именем не протекают ни в отчёт, ни в перенос (Task 4: `ignores another household`; Task 5: `404 for a category of another household`).

---

### Task 1: Переиспользуемый коэффициент пересчёта валют

**Files:**
- Modify: `src/modules/bill/household-conversion.ts`
- Modify: `src/modules/bill/index.ts`
- Test: `src/modules/bill/household-conversion.int-spec.ts` (существующий, должен остаться зелёным)

**Interfaces:**
- Produces:
  - `currencyFactorLateral(from: string, to: string, date: string, alias: string): string` — SQL-фрагмент `LEFT JOIN LATERAL … rf … rt … CROSS JOIN LATERAL (SELECT … AS factor, … AS rate_date) <alias>`; `from`/`to`/`date` — SQL-выражения; два `?` — источник курсов (как сейчас). `factor` NULL, если `from` NULL или курса нет.
  - `householdConversionJoin(bill = 'b')` — без изменения поведения, теперь `JOIN households h …` + `currencyFactorLateral(`${bill}.currency`, 'h.currency', `${bill}.bill_date`, 'fx')`. Алиасы внутренних lateral'ов уникализировать по `alias` (`${alias}_rf`, `${alias}_rt`), чтобы фрагмент можно было вставить дважды.
  - Экспорт из `src/modules/bill/index.ts`: `currencyFactorLateral`, `householdConversionJoin`, `loadRateDays`, `fetchUnconverted`, `UnconvertedDto`.

- [ ] **Step 1: Прогнать существующие тесты конвертации как базу**

Run: `npm test -- household-conversion spending-breakdown bill-dashboard`
Expected: PASS

- [ ] **Step 2: Вынести `currencyFactorLateral` и переписать `householdConversionJoin` через него**

- [ ] **Step 3: Прогнать те же тесты**

Run: `npm test -- household-conversion spending-breakdown bill-dashboard`
Expected: PASS, число тестов то же.

- [ ] **Step 4: Экспортировать из barrel, проверить архитектуру**

Run: `npm run type-check && npm run arch && npm run knip`
Expected: без ошибок. Если `arch` сообщает цикл `bill ↔ category-limit` — перенести `currencyFactorLateral` и `UnconvertedDto` в `src/common/sql/currency-factor.ts` / `src/common/dto/unconverted.dto.ts` и реэкспортировать из `bill`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/bill
git commit -m "refactor(bill): reusable currency factor for read-time conversion (HAN-25)"
```

---

### Task 2: Таблица отметок «не переносить»

**Files:**
- Create: `src/entities/category-limit-carry-stop.entity.ts`
- Create: `src/migrations/Migration20261117100000_AddCategoryLimitCarryStops.ts`
- Modify: `src/migrations/.snapshot-accounting.json` (генерируется)
- Modify: `src/modules/category-limit/category-limit.module.ts` (`forFeature` + сущность)

**Interfaces:**
- Produces: сущность `CategoryLimitCarryStop` (`tableName: 'category_limit_carry_stops'`): `household: Rel<Household>` (cascade, `category_limit_carry_stops_household_id_fkey`), `category: Rel<Category>` (cascade), `period_type: LimitPeriodType` (`nativeEnumName: 'limit_period_type'`), `period_start: string` (`date`, `runtimeType: 'string'`), `created_by: Rel<User> | null` (`created_by_id`, set null), `created_at: Date` (`timestamptz`, `defaultRaw: 'NOW()'`). Unique `category_limit_carry_stops_unique` на `(category, period_type, period_start)`; index `category_limit_carry_stops_household_index` на `(household, period_type, category, period_start)`; index на `created_by`. Образец — `src/entities/category-limit.entity.ts`.

- [ ] **Step 1: Создать сущность и зарегистрировать в модуле**

- [ ] **Step 2: Сгенерировать миграцию и привести к стилю проекта**

Run: `npm run migration:create`
Затем переименовать в `Migration20261117100000_AddCategoryLimitCarryStops`, добавить комментарий-шапку и `set local` таймауты в up/down (образец — `Migration20261116100000_AddHouseholdMemberDisplayName.ts`). down: `drop table if exists "category_limit_carry_stops";`.

- [ ] **Step 3: Применить и проверить up/down**

Run: `npm run migration:up && npm run migration:down && npm run migration:up && npm run migration:check && npm run migration:drift && npm run migrations:lint`
Expected: все команды без ошибок, дрейфа нет.

- [ ] **Step 4: Commit**

```bash
git add src/entities/category-limit-carry-stop.entity.ts src/migrations src/modules/category-limit/category-limit.module.ts
git commit -m "feat(category-limits): carry-stop marks table (HAN-25)"
```

---

### Task 3: Цепочки периодов и свёртка отчёта (чистые функции)

**Files:**
- Create: `src/modules/category-limit/limit-report.ts`
- Test: `src/modules/category-limit/limit-report.spec.ts`

**Interfaces:**
- Consumes: `limitPeriodStart`, `limitPeriodEnd` (`period-range.ts`), `LimitPeriodType`, `Currency`, `UnconvertedDto` (Task 1).
- Produces:

```ts
export interface ReportVersion {      // версии типа T, effective_from < end
  id: string; category_id: string; amount: string; currency: Currency;
  effective_from: string; effective_to: string | null;
}
export interface CarryStop { category_id: string; period_start: string }
export interface ChainPeriod { period_start: string; version: ReportVersion }

/** Периоды цепочки каждой категории, от P0 до start включительно, по возрастанию.
 *  В ключах — только категории с версией в периоде start. */
export function chainPeriods(
  type: LimitPeriodType, start: string,
  versions: ReportVersion[], stops: CarryStop[],
): Map<string, ChainPeriod[]>;

export interface ReportCategoryInfo { category_id: string; name: string; archived: boolean }
export interface SpentRow {           // одна строка агрегата (category, sub, bucket)
  category_id: string | null; bucket: string; total: string; unconverted_lines: number;
}
export interface LimitReportInput {
  type: LimitPeriodType; start: string; end: string; currency: Currency;
  chains: Map<string, ChainPeriod[]>;
  categories: Map<string, ReportCategoryInfo>;
  /** base limit in household currency per `${version.id}|${period_start}`; null = нет курса */
  baseLimits: Map<string, string | null>;
  spent: SpentRow[];                  // bucket ∈ [chainStart, end)
  stops: CarryStop[];
  /** категории с версией любого типа, пересекающей [start, end) */
  limitedCategoryIds: Set<string>;
  unconverted: UnconvertedDto[];
}
export function buildLimitReport(input: LimitReportInput): LimitReportDto; // DTO из Task 4, здесь — интерфейс с теми же полями
```

`chainPeriods`: от `start` идти назад (`limitPeriodStart(type, addDays(p, -1))`), пока у категории есть версия с `effective_from <= p AND (effective_to IS NULL OR effective_to > p)` и предыдущий период не отмечен стопом; стоп на `p − 1` останавливает так, что `p` — первый период цепочки.

`buildLimitReport`: для каждой цепочки — проход с `carry = 0`; в периоде: `base` = `baseLimits`; если `base === null` → `limit/remaining/percent = null`, следующий `carry = 0`, флаг `carry_incomplete` для всех последующих; иначе `limit = base + carry`, `remaining = limit − spent`, следующий `carry = stopped(p) ? 0 : remaining`. `unconverted_lines > 0` в периоде до P → `carry_incomplete` у P. Итог — по категориям с `base_limit !== null`. `other_spent` — строки `bucket === start` с `category_id === null` или не в `limitedCategoryIds`. Сортировка — `name.localeCompare`, затем `category_id`. Типы DTO объявить в `dto/limit-report.dto.ts` (Task 4) заранее как классы без декораторов — или здесь как интерфейсы, а Task 4 сделает классы, `implements`. Выбрать второе.

- [ ] **Step 1: Написать падающие тесты**

Фикстура: тип `MONTHLY`, валюта EUR, категория `food` с одной версией `{amount: '100', currency: EUR, effective_from: '2026-01-01', effective_to: null}`, `baseLimits` = 100 для каждого периода, `start = '2026-10-01'`.

```ts
describe('chainPeriods', () => {
  it('runs back to the first period of the version', ...)          // '2026-01-01'…'2026-10-01', 10 периодов
  it('starts after the latest stop', ...)                           // стоп '2026-07-01' → первый '2026-08-01'
  it('keeps the chain across an amount change', ...)                // версии [01-01,06-01) 100 и [06-01,∞) 150 → 10 периодов
  it('breaks on a period without a version', ...)                   // версии [01-01,04-01) и [05-01,∞) → первый '2026-05-01'
  it('omits a category with no version in the period', ...)         // версия закрыта 2026-10-01 → нет ключа
  it('ignores a stop outside the chain', ...)                       // стоп '2025-12-01' → как без стопа
  it('handles quarters and half-years', ...)                        // QUARTERLY, start '2026-10-01', версия с '2026-01-01' → ['2026-01-01','2026-04-01','2026-07-01','2026-10-01']
});

describe('buildLimitReport', () => {
  it('carries a debt into the next period', ...)       // сентябрь 110 → октябрь: carried_in -10, limit 90
  it('carries a surplus', ...)                         // сентябрь 80 → carried_in 20, limit 120
  it('accumulates over periods', ...)                  // авг 110, сен 95 (limit 90) → окт carried_in -15
  it('stops carrying after a marked period', ...)      // сентябрь 110 + стоп сентября → окт carried_in 0, carry_over у сентябрьского отчёта false
  it('debt larger than the limit', ...)                // сентябрь 250 → окт limit -50, percent null, remaining = -50 - spentOct
  it('percent above 100 and below 0', ...)             // limit 100, spent 150 → 150; spent -5 → -5
  it('restarts after an unconvertible base limit', ...) // baseLimits сентября null → окт carried_in 0, carry_incomplete true; base_limit сентября null
  it('flags unconverted lines in an earlier period', ...) // август unconverted_lines 1 → окт carry_incomplete true
  it('counts other spending', ...)                     // строки null и 'clothes' (не в limitedCategoryIds) → other_spent; 'travel' в limitedCategoryIds без цепочки → не входит
  it('totals only convertible limits', ...)            // две категории, у одной base null → total по одной
  it('rounds in cents', ...)                           // spent '0.1' + '0.2' → 0.3 ровно
  it('empty report', ...)                              // нет цепочек → categories [], total нули, percent null
  it('sorts by name then id', ...)
});
```

- [ ] **Step 2: Убедиться, что падают**

Run: `npm test -- limit-report.spec`
Expected: FAIL (`Cannot find module './limit-report'`).

- [ ] **Step 3: Реализовать `chainPeriods` и `buildLimitReport` в `limit-report.ts`**

- [ ] **Step 4: Тесты зелёные**

Run: `npm test -- limit-report.spec`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/category-limit/limit-report.ts src/modules/category-limit/limit-report.spec.ts
git commit -m "feat(category-limits): carry-over chains and report fold (HAN-25)"
```

---

### Task 4: Сервис отчёта и `GET /category-limits/report`

**Files:**
- Create: `src/modules/category-limit/limit-report.service.ts`
- Create: `src/modules/category-limit/dto/limit-report.dto.ts`
- Modify: `src/modules/category-limit/category-limit.controller.ts`, `decorators/api-responses.decorator.ts`, `category-limit.module.ts` (импорт `ExchangeRateModule`, провайдер), `index.ts`
- Test: `src/modules/category-limit/limit-report.int-spec.ts`

**Interfaces:**
- Consumes: Task 1 (`currencyFactorLateral`, `householdConversionJoin`, `loadRateDays`, `fetchUnconverted`, `UnconvertedDto`), Task 3 (`chainPeriods`, `buildLimitReport`, типы).
- Produces:
  - `LimitReportQueryDto { period_type: LimitPeriodType (IsEnum, required); date?: string (IsCalendarDate) }`
  - `LimitReportDto`, `LimitReportCategoryDto`, `LimitReportTotalDto` — классы с `@ApiProperty`, поля ровно как в спеке («Ответ отчёта»).
  - `LimitReportService.report(householdId: string, type: LimitPeriodType, date?: string, now: Date = new Date()): Promise<LimitReportDto>`
  - Контроллер: `@Get('report')` (объявить **до** параметрических маршрутов), `report(ctx, query)`.

Порядок в `report`:
1. `start/end` по `date ?? todayIsoDate(now)`.
2. Запрос 1 (одна транзакция чтения): версии типа T с `effective_from < end`, категории с `name`, `deleted_at`; отметки типа T с `period_start <= start` (отметка на сам P даёт `carry_over: false`); `category_id` версий любого типа, пересекающих `[start, end)`.
3. `chainPeriods(...)`; `chainStart = min(первых периодов, start)`.
4. `loadRateDays(conn, rates, hid, chainStart, end)` + `rates.ensureDays(дни min(period_start, today) для версий в валюте ≠ бюджета, {max: 10})`.
5. Базовые лимиты: один запрос `SELECT k.key, ROUND(k.amount * f.factor, 2) FROM unnest(?::text[], ?::numeric[], ?::currency_enum[], ?::date[]) k(key, amount, currency, day) JOIN households h ON h.id = ? <currencyFactorLateral('k.currency','h.currency','k.day','f')>`; версии в валюте бюджета — без пересчёта.
6. Траты: агрегат по `(l.category_id, l.sub_category_id, bucket)` за `[chainStart, end)` с `householdConversionJoin('b')`, `ROUND(SUM(l.amount * fx.factor), 2)`, `COUNT(*) FILTER (WHERE fx.factor IS NULL)`. `bucket`: `MONTHLY` — `date_trunc('month', b.bill_date)::date`, `QUARTERLY` — `'quarter'`, `YEARLY` — `'year'`, `SEMI_ANNUAL` — `make_date(extract(year from b.bill_date)::int, CASE WHEN extract(month from b.bill_date) <= 6 THEN 1 ELSE 7 END, 1)`. Выражение выбирать по enum в коде, не из ввода.
7. `fetchUnconverted(conn, source, hid, start, end)`.
8. `buildLimitReport(...)`.

Фикстура int-теста: по образцу `category-limit.int-spec.ts` + `household-conversion.int-spec.ts` (`StubProvider` с `RATES`, `ExchangeRateService` через `Test.createTestingModule`). Домохозяйство A (EUR), B (EUR, чужое), C (MDL → EUR для лимита в другой валюте). `NOW = 2026-11-15`. Лимиты пишутся через `CategoryLimitService` с `now` (как в HAN-24), чеки — прямыми insert'ами `bills` + `bill_sub_categories` (`status`, `currency`, `bill_date`, `category_id`, `sub_category_id`).

- [ ] **Step 1: Написать падающие int-тесты**

```ts
it('month/quarter/half/year bounds: last day in, next first day out')
it('past period uses the version then in force; month → quarter switch per HAN-24 example')
it('spec example: Sept 110 of 100 → Oct limit 90; mark Sept → 100; unmark → 90; Sept 80 → 120')
it('editing an old bill changes the carry into the current period')
it('removed limit shows until period end; recreated starts without carry')
it('spent equals the spending breakdown total of the category to the cent')   // SpendingBreakdownService, period 'custom', тот же диапазон, 3 строки с курсом, дающим полуцентовые значения
it('counts the converted part only')        // EUR-бюджет: строка USD с курсом + строка USD на день без курса → spent только первая, unconverted_lines 1, unconverted [{currency: USD, bill_count: 1}]; other_spent не содержит ни одну
it('bill without currency is unconverted')
it('limit in another currency converts at the period start rate; without a rate base_limit is null and out of the total')
it('drafts, failed, duplicates and deleted bills are not counted')
it('a negative line lowers spent')
it('a line with a category and no sub-category counts in its category')
it('other_spent: uncategorized and categories without any limit; a quarterly-limited category is not in the monthly other_spent')
it('archived category with a limit in force is listed')
it('future period: carry from the current one, spent from existing bills')
it('empty before the first limit')          // date '2020-01-15' → categories [], total нули, percent null, other_spent по тратам января 2020
it('ignores another household')             // B: такие же лимиты и чеки → в отчёте A не видны
it('defaults date to today')
```

Плюс в `category-limit.controller` — проверка валидации через `ValidationPipe` (как в существующих тестах DTO): `period_type` отсутствует → 400; `date: '2026-02-30'` → 400.

- [ ] **Step 2: Убедиться, что падают**

Run: `npm test -- limit-report.int-spec`
Expected: FAIL (нет `LimitReportService`).

- [ ] **Step 3: DTO, сервис, контроллер, Swagger-декоратор `ApiLimitReportResponses` (200, 400, 403), модуль, barrel**

- [ ] **Step 4: Тесты зелёные + регрессия**

Run: `npm test -- limit-report category-limit household-conversion spending-breakdown`
Expected: PASS

- [ ] **Step 5: EXPLAIN траты-запроса на фикстуре**

Run (psql на тестовой БД): `EXPLAIN` запроса из шага 6 с параметрами домохозяйства A.
Expected: используется `bills_household_status_date_index`. Вывод сохранить для описания PR.

- [ ] **Step 6: Commit**

```bash
git add src/modules/category-limit
git commit -m "feat(category-limits): limits report with carry-over (HAN-25)"
```

---

### Task 5: `PUT /category-limits/:categoryId/carry-over`

**Files:**
- Create: `src/modules/category-limit/dto/carry-over.dto.ts`
- Modify: `src/modules/category-limit/limit-report.service.ts`, `category-limit.controller.ts`, `decorators/api-responses.decorator.ts`
- Test: `src/modules/category-limit/limit-report.int-spec.ts` (новый `describe`)

**Interfaces:**
- Consumes: Task 2 (`CategoryLimitCarryStop`), Task 4 (`report`).
- Produces:
  - `SetCarryOverDto { period_type: LimitPeriodType; period_start: string (IsCalendarDate); carry_over: boolean (IsBoolean) }`
  - `LimitReportService.setCarryOver(householdId: string, userId: string, categoryId: string, dto: SetCarryOverDto, now: Date = new Date()): Promise<LimitReportCategoryDto>`
  - Контроллер `@Put(':categoryId/carry-over')`, `@HttpCode(200)`, `ParseUUIDPipe`.

Логика: 400, если `period_start !== limitPeriodStart(type, period_start)` или `period_start > todayIsoDate(now)`. 404 (`NotFoundException`), если категории нет в бюджете (удалённые допускаются) или нет версии типа T, действующей на `period_start`. `carry_over: false` → `INSERT … ON CONFLICT (category_id, period_type, period_start) DO NOTHING`; `true` → `DELETE`. Ответ: строка категории из `report(hid, type, limitPeriodEnd(type, period_start), now)`; если в следующем периоде у категории лимита нет — строка из отчёта за сам `period_start` *(решение плана: спека не покрывает этот край; клиент всё равно видит `carry_over`)*.

- [ ] **Step 1: Падающие int-тесты**

```ts
it('marks and unmarks, both idempotent; response is the next period row with the new limit') // сентябрь 110: PUT false → carried_in 0, limit 100; повтор → то же; PUT true → limit 90
it('allows the current period')            // period_start '2026-11-01' при NOW 2026-11-15 → 200
it('400 when period_start is not a period start')   // '2026-11-15'
it('400 for a future period')              // '2026-12-01'
it('404 when the category has no version of the type then')
it('404 for a category of another household')
it('allows an archived category with a version then')
it('falls back to the marked period row when the next period has no limit')
```

- [ ] **Step 2: Убедиться, что падают**

Run: `npm test -- limit-report.int-spec -t carry-over`
Expected: FAIL

- [ ] **Step 3: Реализовать DTO, метод сервиса, маршрут, Swagger `ApiSetCarryOverResponses` (200, 400, 403, 404)**

- [ ] **Step 4: Тесты зелёные**

Run: `npm test -- limit-report`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/category-limit
git commit -m "feat(category-limits): mark a period not to carry over (HAN-25)"
```

---

### Task 6: Полная проверка

- [ ] **Step 1:** Run: `npm run verify`
Expected: type-check, lint, arch, dup, knip, все тесты — без ошибок.

- [ ] **Step 2:** Run: `npm run migration:check && npm run migration:drift`
Expected: чисто.

- [ ] **Step 3:** Открыть Swagger (`/api/docs` локально) — оба эндпоинта описаны, примеры ответов на месте.

- [ ] **Step 4:** Commit, если что-то поправлено:

```bash
git commit -am "chore(category-limits): verify fixes (HAN-25)"
```
