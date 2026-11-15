# HAN-23 Move Bills Between Households — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /households/:hid/bills/move` переносит 1–100 чеков в другой бюджет одной транзакцией, пересопоставляя
категории, подкатегории и магазин по именам.

**Architecture:** Новый `BillMoveService` в модуле `bill`: блокировка чеков `FOR UPDATE`, проверки всей пачки
(одно 404 / одно 409), магазины через `MarketService.findOrCreate`, ремап позиций одним SQL `UPDATE … FROM`,
смена `household_id`, удаление отметок «не дубликат», запись в `logs`; после коммита — прогрев курсов общим хелпером.
Проверка членства в целевом бюджете — общая функция модуля `household`, её же использует `HouseholdMemberGuard`.

**Tech Stack:** NestJS 11, MikroORM (postgresql, legacy decorators), class-validator, Jest (unit `*.spec.ts`,
int `*.int-spec.ts` против реальной БД из `createMikroOrmConfig()`).

**Spec:** `docs/superpowers/specs/2026-11-15-han-23-move-bills-design.md` (утверждена 2026-11-15).

## Global Constraints

- Ветка `feat/han-23-move-bills` (от `origin/dev`); коммиты `feat(bill): … (HAN-23)`; в PR `Fixes HAN-23`, база `dev`.
- Модули импортируют друг друга только через `src/modules/<m>/index.ts` (проверяет `npm run arch`).
- Перед «готово»: `npm run verify` зелёный (type-check, lint:check, arch, dup, knip, test).
- Пачка: 1–100 уникальных uuid v4; `target_household_id` — uuid v4.
- Ремап: живая пара `lower(category.name)`+`lower(sub_category.name)` в целевом → иначе живая категория
  `lower(name)` без подкатегории → иначе `category_id = sub_category_id = null`. Недостающие не создаём.
- Причины 409 ровно: `status_not_movable`, `has_duplicates`, `draft_image_conflict`, `client_batch_conflict`.
- Не меняются у чека: `currency`, `amount`, `status`, `source`, `image_key`, `image_sha256`, `ai_request_id`,
  `created_by`, `confirmed_by`, `client_batch_*`, `fiscal_*`.

## Review Focus

1. **Два параллельных переноса одной пачки** — второй ждёт блокировку, затем видит чеки в целевом и отвечает 200
   с `already_moved: true` (а не 404 и не двойной ремап). Тест — Task 5.
2. **Удалённая (мягко) категория/подкатегория источника** — сопоставляется по имени, как живая. Тест — Task 4.
3. **Целевой бюджет удалён мягко, а членство осталось** → 403, ничего не изменилось. Тест — Task 5.
4. **Черновик с фото, а в целевом есть подтверждённый чек с тем же `image_sha256`** — это не конфликт
   (уникальность только среди черновиков), перенос проходит. Тест — Task 5.
5. **Чек без позиций** — переносится, `lines_total = 0`, счётчики 0. Тест — Task 4.

---

### Task 1: Общая проверка членства в бюджете

**Files:**
- Create: `src/modules/household/household-membership.ts`
- Create: `src/modules/household/household-membership.spec.ts`
- Modify: `src/modules/household/guards/household-member.guard.ts` (тело `canActivate` после проверки uuid)
- Modify: `src/modules/household/index.ts` (экспорт)

**Interfaces:**
- Produces: `findHouseholdRole(households: EntityRepository<Household>, members: EntityRepository<HouseholdMember>, householdId: string, userId: string): Promise<'owner' | 'member' | null>` —
  `null`, если бюджет не найден, удалён (`deleted_at` не null) или пользователь не участник. Экспорт из
  `household/index.ts`.

- [ ] **Step 1: Write the failing test** — `household-membership.spec.ts`, моки репозиториев как в
  `household-member.guard.spec.ts`:
  - `returns null when the household is missing or deleted` — `households.findOne` → `null`; `members.findOne` не вызван.
  - `returns null when the user is not a member` — household есть, member `null`.
  - `returns the member role` — member `{ role: 'owner' }` → `'owner'`; `households.findOne` вызван с `{ id, deleted_at: null }`,
    `members.findOne` с `{ household: { id }, user: { id: userId } }`.
- [ ] **Step 2:** `npm test -- src/modules/household/household-membership.spec.ts` → FAIL (module not found).
- [ ] **Step 3:** Реализовать `findHouseholdRole`; в guard заменить два `findOne` на вызов функции (`null` → `ForbiddenException`).
- [ ] **Step 4:** `npm test -- src/modules/household` → PASS (включая неизменённый `household-member.guard.spec.ts`).
- [ ] **Step 5: Commit** `refactor(household): share the membership lookup (HAN-23)`.

### Task 2: Общий прогрев курсов для пачки чеков

**Files:**
- Create: `src/modules/bill/bill-rates.ts`
- Create: `src/modules/bill/bill-rates.spec.ts`
- Modify: `src/modules/bill/manual-bill-batch.service.ts:257-280` (`warmRates` → вызов хелпера)

**Interfaces:**
- Produces: `warmBillRates(rates: Pick<ExchangeRateService, 'ensureDays'>, log: Logger, householdCurrency: Currency, bills: Pick<Bill, 'currency' | 'bill_date'>[], what: string): Promise<void>` —
  уникальные `bill_date` чеков с `currency` (не null/undefined) ≠ `householdCurrency`; пусто → не вызывает;
  иначе `ensureDays(days, { max: days.length })`; ошибка → `log.warn(\`Could not save rates for ${what}: …\`)`, не бросает.

- [ ] **Step 1: Write the failing test** — `bill-rates.spec.ts`:
  - `asks once for the unique days of bills in a foreign currency` — bills `[{USD,'2026-11-01'},{USD,'2026-11-01'},{EUR,'2026-11-02'},{undefined,'2026-11-03'}]`, household `EUR` → `ensureDays(['2026-11-01'], { max: 1 })`.
  - `does nothing when every bill is in the household currency`.
  - `logs and swallows a provider error` — `ensureDays` rejects → resolves, `log.warn` called once.
- [ ] **Step 2:** `npm test -- src/modules/bill/bill-rates.spec.ts` → FAIL.
- [ ] **Step 3:** Реализовать; `ManualBillBatchService.warmRates` удалить, вызывать `warmBillRates(this.exchangeRates, this.log, currency, bills, 'a manual batch')`.
  Внимание: старый фильтр брал чеки с `currency === undefined` тоже — новый их пропускает (у них нет курса); это верно.
- [ ] **Step 4:** `npm test -- src/modules/bill/bill-rates.spec.ts src/modules/bill/manual-bill-batch` → PASS.
- [ ] **Step 5: Commit** `refactor(bill): share rate warming for bill batches (HAN-23)`.

### Task 3: DTO переноса

**Files:**
- Create: `src/modules/bill/dto/move-bills.dto.ts`
- Create: `src/modules/bill/dto/move-bills.dto.spec.ts`

**Interfaces:**
- Produces (все с `@ApiProperty`):
  - `class MoveBillsDto { bill_ids: string[]; target_household_id: string }` — `@IsArray @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique @IsUUID('4', { each: true })`; `@IsUUID('4')`.
  - `class MovedBillDto { id: string; lines_total: number; lines_lost_sub_category: number; lines_lost_category: number; already_moved: boolean }`
  - `class MoveBillsResponseDto { target_household_id: string; bills: MovedBillDto[] }`
  - `enum MoveConflictReason { STATUS_NOT_MOVABLE = 'status_not_movable', HAS_DUPLICATES = 'has_duplicates', DRAFT_IMAGE_CONFLICT = 'draft_image_conflict', CLIENT_BATCH_CONFLICT = 'client_batch_conflict' }`
  - `class MoveBillConflictDto { id: string; reason: MoveConflictReason }`
  - `class MoveBillsConflictResponseDto { statusCode: number /*409*/; message: string; conflicts: MoveBillConflictDto[] }`
  - `class MoveBillsNotFoundResponseDto { statusCode: number /*404*/; message: string; bill_ids: string[] }`

- [ ] **Step 1: Write the failing test** — `validate(plainToInstance(MoveBillsDto, body))`:
  ok для 1 и 100 id; ошибка для `[]`, 101 id, повтора id, `'not-a-uuid'` в массиве, отсутствующего/неверного `target_household_id`.
- [ ] **Step 2:** `npm test -- src/modules/bill/dto/move-bills.dto.spec.ts` → FAIL.
- [ ] **Step 3:** Реализовать файл.
- [ ] **Step 4:** тот же запуск → PASS.
- [ ] **Step 5: Commit** `feat(bill): move-bills DTOs (HAN-23)`.

### Task 4: `BillMoveService` — перенос и ремап

**Files:**
- Create: `src/modules/bill/bill-move.service.ts`
- Create: `src/modules/bill/bill-move.int-spec.ts`

**Interfaces:**
- Consumes: `findHouseholdRole` (Task 1), `warmBillRates` (Task 2), DTO (Task 3), `MarketService.findOrCreate(em, householdId, { name, city?, country?, address? })`.
- Produces: `class BillMoveService { constructor(em: EntityManager, markets: MarketService, exchangeRates: ExchangeRateService); move(sourceHouseholdId: string, userId: string, dto: MoveBillsDto): Promise<MoveBillsResponseDto> }`

Порядок внутри `em.transactional(async (em) => …)` — как в спеке, § «Сервис», пп. 1–8. В этой задаче:
членство (`null` → `ForbiddenException()`), `target === source` → `BadRequestException('Target household is the source household')`,
блокировка `SELECT id, household_id, status, image_sha256, client_batch_id, client_batch_index, market_id FROM bills WHERE id = ANY(?) AND household_id IN (?, ?) AND deleted_at IS NULL ORDER BY id FOR UPDATE`
(через `em.getConnection().execute(sql, params, 'all', em.getTransactionContext())`, как `MarketService.findOrCreate`),
магазины, ремап (SQL из спеки), `UPDATE bills`, `DELETE` отметок, `em.create(Log, { level: LogLevel.INFO, source: LogSource.API, context: 'BillMove', message, metadata, user })`.
Ответ — `bills` в порядке `dto.bill_ids`. 404/409/`already_moved` — Task 5 (здесь чеки вне обоих бюджетов можно пока молча пропускать).
После транзакции: `warmBillRates(…, targetCurrency, movedBills, 'a bill move')`.

Фикстура int-теста (`beforeAll`, по образцу `manual-bill-edit.int-spec.ts`): пользователь U — участник A (EUR) и B (MDL)
(`insert into household_members (household_id, user_id, role)`); A: `Food › {Bread, Milk}`, `Transport › {Taxi}`, `Misc`,
магазины `Lidl` (city `Chisinau`), `Kaufland`; B: `food › {bread}`, `Transport` (без подкатегорий), магазин `LIDL`.
`afterAll` чистит всё по обоим household. Конструирование: `new BillMoveService(fork, new MarketService(fork.getRepository(Market), fork), new ExchangeRateService(fork, new StubProvider()))`.

- [ ] **Step 1: Write the failing tests** (`describe('bill move (PostgreSQL)')`):
  - `remaps lines by pair, then by category, else clears them` — чек в A с позициями
    Food›Bread, Food›Milk, Transport›Taxi, Misc (только категория), Food (только категория), без категории; все с
    `category_confidence 0.9`, `category_reasoning 'x'`. После `move(A, U, { bill_ids: [id], target_household_id: B })`:
    позиции → (food,bread), (food,null), (Transport,null), (null,null), (food,null), (null,null);
    ответ `{ lines_total: 6, lines_lost_sub_category: 2, lines_lost_category: 1, already_moved: false }`;
    `category_confidence`/`reasoning` = null ровно у Milk, Taxi, Misc, у остальных 0.9/'x'.
  - `matches a deleted source category by name` — Food в A помечен `deleted_at`, позиция Food›Bread → (food,bread).
  - `does not match a deleted target category` — `food` в B удалён → позиция Food›Bread → (null,null), `lost_category 1`.
  - `reuses the target market ignoring case` — чек с `Lidl` → `market_id` = id `LIDL` в B.
  - `creates a missing market with its details` — `Kaufland` → новый магазин в B с теми же city/country/address.
  - `leaves a bill without market or with a deleted market without one` → `market_id` null.
  - `moves a bill without lines` → `lines_total 0`.
  - `drops duplicate dismissals of moved bills` — отметка (moved, other) удалена, (other1, other2) осталась.
  - `writes one log entry` — `logs` с `context = 'BillMove'`, `user_id = U`, `metadata.bill_ids` = переданные.
  - `shows the bill in the target lists, not the source ones` — `BillCrudService.listBills(A, {})` не содержит,
    `listBills(B, {})` содержит (конструирование `BillCrudService` — как в `manual-bill-edit.int-spec.ts`).
  - `keeps the draft photo readable from the target` — черновик с `image_key 'ai/images/A/x.jpg'` →
    `getDraftImageKey(id, B)` = тот же ключ.
- [ ] **Step 2:** `npm test -- src/modules/bill/bill-move.int-spec.ts` → FAIL (module not found).
- [ ] **Step 3:** Реализовать `BillMoveService.move` (без 404/409/already_moved).
- [ ] **Step 4:** тот же запуск → PASS.
- [ ] **Step 5: Commit** `feat(bill): move bills to another household with category remap (HAN-23)`.

### Task 5: Отказы, повтор и всё-или-ничего

**Files:**
- Modify: `src/modules/bill/bill-move.service.ts`
- Modify: `src/modules/bill/bill-move.int-spec.ts`

**Interfaces:**
- Consumes: `MoveConflictReason`, тела `MoveBillsConflictResponseDto` / `MoveBillsNotFoundResponseDto` (Task 3).
- Produces: исключения `NotFoundException({ statusCode: 404, message: 'Some bills were not found', bill_ids })`,
  `ConflictException({ statusCode: 409, message: 'Some bills cannot be moved', conflicts })`; чеки уже в целевом —
  `{ …нули, already_moved: true }`, без изменений; если переносить нечего — без записи в `logs`.

Проверки (по одному запросу на вид, по чекам в исходном): статус ∉ {draft, confirmed} → `status_not_movable`;
`EXISTS bills d WHERE d.duplicate_of_id = b.id AND d.status = 'duplicate' AND d.deleted_at IS NULL` → `has_duplicates`;
черновик и `EXISTS` живой черновик в целевом с тем же `image_sha256` → `draft_image_conflict`;
`client_batch_id` не null и `EXISTS` чек в целевом (удалённые тоже) с той же парой → `client_batch_conflict`.
Один чек может иметь несколько причин — по записи на причину. Порядок: 403 → 400 → блокировка → 404 → 409.

- [ ] **Step 1: Write the failing tests:**
  - `403 when the user is not a member of the target` — пользователь U2 только в A → `ForbiddenException`.
  - `403 when the target household is deleted` — B2 с `deleted_at`, U участник → `ForbiddenException`, чек в A.
  - `400 when the target is the source`.
  - `404 lists bills found in neither household` — id из третьего бюджета и удалённый в A → `bill_ids` = оба, чек-соседа из пачки не перенесён.
  - `409 lists every conflict and changes nothing` — пачка: ok-чек, `failed`, `duplicate`, оригинал с живым дубликатом,
    черновик с `image_sha256 'h1'` (в B живой черновик `'h1'`), чек с `client_batch (k, 0)` (в B удалённый чек `(k, 0)`) →
    `conflicts` содержит ровно 5 пар с нужными `reason`; ok-чек остался в A с прежними категориями; магазинов в B не прибавилось.
  - `allows a draft whose photo matches a confirmed target bill` — в B подтверждённый с `'h2'`, черновик `'h2'` переносится.
  - `ignores deleted duplicates of the moved bill` — удалённый дубликат ссылается → перенос проходит, дубликат остался в A с `duplicate_of_id`.
  - `answers a repeat with already_moved and changes nothing` — второй `move` тех же id → 200, `already_moved: true`, нули; `updated_at` позиций не изменился; в `logs` одна запись.
  - `moves only the new bills of a mixed repeat` — [уже в B, новый в A] → первый `already_moved`, второй перенесён.
  - `serializes concurrent moves of the same bills` — два `move` через разные `orm.em.fork()` через `Promise.all` → оба
    успешны, ровно один ответ с `already_moved: false`; позиции сопоставлены один раз.
- [ ] **Step 2:** `npm test -- src/modules/bill/bill-move.int-spec.ts` → новые FAIL.
- [ ] **Step 3:** Реализовать проверки в сервисе.
- [ ] **Step 4:** тот же запуск → все PASS.
- [ ] **Step 5: Commit** `feat(bill): reject unmovable bills and answer repeats on move (HAN-23)`.

### Task 6: Эндпоинт, Swagger, подключение в модуль

**Files:**
- Modify: `src/modules/bill/bill.controller.ts` (метод после `createManualBatch`, до `@Get()`)
- Modify: `src/modules/bill/dto/api-responses.decorator.ts` (`ApiMoveBillsResponses`)
- Modify: `src/modules/bill/bill.module.ts` (`BillMoveService` в `providers`)
- Modify: `src/modules/bill/bill.controller.spec.ts` (мок `BillMoveService` в тест-модуле, тест метода)

**Interfaces:**
- Consumes: `BillMoveService.move` (Task 4–5), DTO (Task 3).
- Produces: `@Post('move') @HttpCode(HttpStatus.OK) moveBills(@CurrentUser() user, @CurrentHousehold() ctx, @Body() dto: MoveBillsDto): Promise<MoveBillsResponseDto>` → `billMove.move(ctx.householdId, user.id, dto)`.

`ApiMoveBillsResponses`: 200 `MoveBillsResponseDto` («Bills moved; bills already in the target are flagged already_moved»),
400 `ValidationErrorResponseDto`, 403 («Not a member of the target household, or it does not exist»), 404 `MoveBillsNotFoundResponseDto`,
409 `MoveBillsConflictResponseDto` (перечислить четыре `reason`), 401. `@ApiOperation({ summary: 'Move bills to another household, remapping categories and markets by name' })`.

- [ ] **Step 1: Write the failing test** — в `bill.controller.spec.ts`: `moveBills passes the household and user to BillMoveService` — мок возвращает объект, контроллер отдаёт его, `move` вызван с `(ctx.householdId, user.id, dto)`.
- [ ] **Step 2:** `npm test -- src/modules/bill/bill.controller.spec.ts` → FAIL.
- [ ] **Step 3:** Реализовать метод, декоратор, провайдер.
- [ ] **Step 4:** `npm test -- src/modules/bill` → PASS.
- [ ] **Step 5: Commit** `feat(bill): POST /households/:hid/bills/move (HAN-23)`.

### Task 7: Проверка и PR

- [ ] **Step 1:** `npm run verify` → exit 0 (type-check, lint, arch, dup, knip, все тесты).
- [ ] **Step 2:** `npm run migrations:lint` → нет новых миграций и расхождения снапшота (схема не менялась).
- [ ] **Step 3:** Ручная проверка: поднять приложение, в Swagger (`/api`) виден `POST /households/{hid}/bills/move` со всеми кодами.
- [ ] **Step 4:** Push, PR в `dev` с `Fixes HAN-23`; Linear HAN-23 → In Review, комментарий со ссылкой на PR.
