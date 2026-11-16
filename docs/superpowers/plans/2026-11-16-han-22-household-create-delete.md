# HAN-22 — создание и удаление бюджета: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** новый бюджет сразу с категориями, лимит 5 бюджетов на пользователя, запрет удалить последний бюджет и бюджет с участниками, своё имя бюджета у участника, `bill_count`/`member_count` в списке.

**Architecture:** изменения в `HouseholdService` и `AuthService`; сид категорий умеет работать в транзакции вызывающего; гонки лимита и удаления закрываются `pg_advisory_xact_lock` на пользователя; своё имя — колонка `household_members.display_name`; список — один SQL.

**Tech Stack:** NestJS, MikroORM (PostgreSQL), class-validator, Jest + supertest (e2e/int на реальной БД).

**Spec:** `docs/superpowers/specs/2026-11-16-han-22-household-create-delete-design.md`

## Global Constraints

- Ветка `feat/han-22-household-create-delete`; коммиты `feat(households): … (HAN-22)` + строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Лимит: env `HOUSEHOLD_MAX_HOUSEHOLDS`, целое ≥ 1, по умолчанию `5`; считаются членства любой роли в бюджетах с `deleted_at IS NULL`.
- Коды ошибок: 409 с телом `{ message, reason }`, `reason` ∈ `'household_limit' | 'household_has_members' | 'last_household'`; не owner → 403.
- `bill_count` = чеки с `deleted_at IS NULL` и `status IN ('confirmed','draft')`.
- В ответах бюджета: `name` = `display_name ?? households.name` текущего пользователя; `original_name` = `households.name`.
- `display_name`: `varchar(255) null`; тримится; пустая после трима → 400; `null` — сброс.
- Список сортируется `households.created_at asc, households.id asc`; поле `is_default` не вводим.
- `household.service.ts` импортирует `CategoryDefaultsService` напрямую из `../category/category-defaults.service`, не через barrel `../category` (category.controller уже импортирует `../household` — не создавать цикл через index-файлы).
- Swagger: каждое новое/изменённое поле и 409 описаны в `@ApiProperty` / `@ApiOperation` / `@ApiConflictResponse`.

## Review Focus

1. Принятие приглашения пользователем, который уже участник, при 5 бюджетах — должен ответить `already_member` (как сейчас), а не `household_limit`. → тест в Task 2.
2. Удалённые бюджеты не занимают лимит: после удаления одного из 5 можно создать новый. → тест в Task 2.
3. Приглашение принимается в бюджет, который owner как раз удаляет — участник не должен оказаться в удалённом бюджете (то, что HAN-145 и закрывает). → блокировка строки бюджета в Task 3.
4. «Последний» считается по всем членствам: owner, который ещё и участник чужого бюджета, может удалить свой единственный собственный. → тест в Task 3.
5. Owner переименовал основное имя: участник без своего имени видит новое, участник со своим — своё. → тест в Task 4.

---

### Task 1: Сид категорий в одной транзакции с созданием бюджета и регистрацией

**Files:**
- Modify: `src/modules/category/category-defaults.service.ts`
- Modify: `src/modules/household/household.service.ts` (`createHousehold`), `src/modules/household/household.module.ts` (import `CategoryModule`)
- Modify: `src/modules/auth/auth.service.ts:262-276` (регистрация)
- Modify: `src/modules/household/household.service.spec.ts`, `src/modules/auth/auth.service.spec.ts` (моки)
- Create: `test/household-lifecycle.e2e-spec.ts`

**Interfaces:**
- Produces: `CategoryDefaultsService.seedForHousehold(householdId: string, em?: EntityManager): Promise<SeedCounts>` — с `em` берёт advisory lock и сидирует в нём, без собственной транзакции и без `flush`-коммита наружу; без `em` — как сейчас.
- Produces: `HouseholdService` получает `CategoryDefaultsService` в конструктор; `createHousehold` выполняется в `this.em.transactional(async (txEm) => …)` — Task 2 добавит туда проверку лимита.

- [ ] **Step 1: Write the failing tests** в `test/household-lifecycle.e2e-spec.ts` (каркас как в `test/household-currency.e2e-spec.ts`: `createTestApp`, `registerUser`, `resetThrottling`):
  - `creates a household with the default categories`: `POST /households {name:'Trip'}` → 201; `GET /households/:id/categories` возвращает столько корневых категорий, сколько `DEFAULT_CATEGORY_TREE.length`, имена совпадают.
  - `uses the given currency, else the user's`: с `currency:'MDL'` → `MDL`; без — `EUR`.
  - Откат — в том же app через `jest.spyOn(app.get(CategoryDefaultsService), 'seedForHousehold').mockRejectedValueOnce(new Error('seed down'))` (spy восстанавливать в `afterEach`):
    - `rolls registration back when seeding fails`: `POST /auth/register` → 500; `select count(*) from users where email = ?` = 0.
    - `rolls household creation back when seeding fails`: зарегистрированный пользователь, spy, `POST /households` → 500; в `GET /households` по-прежнему один бюджет.
- [ ] **Step 2: Run** `npm run test:e2e -- household-lifecycle` — Expected: FAIL (нет категорий; регистрация отвечает 201).
- [ ] **Step 3: Implement** `seedForHousehold(householdId, em?)`: при `em` — `execute('select pg_advisory_xact_lock(hashtext(?))', [householdId], 'all', em.getTransactionContext())` и `this.seed(em, householdId)`; лог — как сейчас.
- [ ] **Step 4: Implement** `createHousehold`: household + member + `await this.categoryDefaults.seedForHousehold(household.id, txEm)` в одном `transactional`. Регистрация: вызов сида внутри существующего `this.em.transactional((txEm) => …)` после `persist` (+ `await txEm.flush()` перед сидом, чтобы FK на household существовал); `try/catch` с логом и комментарием про бэкфилл удалить.
- [ ] **Step 5: Fix unit mocks**: в `household.service.spec.ts` передать мок `{ seedForHousehold: jest.fn().mockResolvedValue({categoriesCreated:0,subCategoriesCreated:0}) }`; в `auth.service.spec.ts` — проверить, что `seedForHousehold` вызван с `(household.id, txEm)`; убрать тест «регистрация продолжается, если сид упал», если он есть.
- [ ] **Step 6: Run** `npm test -- household auth category-defaults` и `npm run test:e2e -- household-lifecycle category-seed-defaults auth-registration` — Expected: PASS.
- [ ] **Step 7: Commit** `feat(households): seed default categories in the creating transaction (HAN-22)`.

### Task 2: Лимит числа бюджетов

**Files:**
- Create: `src/modules/household/household-limits.env.ts`, `src/modules/household/household-limits.env.spec.ts`
- Create: `src/modules/household/household-locks.ts`
- Modify: `src/modules/household/household.module.ts`, `src/modules/household/household.service.ts` (`createHousehold`, `acceptInvite`), `src/modules/household/household.controller.ts` (Swagger 409), `.env.example`
- Test: `test/household-lifecycle.e2e-spec.ts`, `test/household-invites.e2e-spec.ts`

**Interfaces:**
- Produces: `MAX_HOUSEHOLDS: symbol`, `readMaxHouseholds(): number` (env `HOUSEHOLD_MAX_HOUSEHOLDS`, по умолчанию 5, ошибка `HOUSEHOLD_MAX_HOUSEHOLDS must be a whole number >= 1, got "<raw>"`) — копия формы `household-invites.env.ts`.
- Produces: `lockUserHouseholds(em: EntityManager, userId: string): Promise<void>` — `pg_advisory_xact_lock(hashtext('household-count:' || ?))` в транзакции `em`.
- Produces: `countLiveMemberships(em: EntityManager, userId: string): Promise<number>` (там же) — `em.count(HouseholdMember, { user: { id: userId }, household: { deleted_at: null } })`.
- Produces: приватный `HouseholdService.limitReached(): ConflictException` с `{ message: 'A user can belong to at most N households', reason: 'household_limit' }`.

- [ ] **Step 1: Write the failing tests**
  - unit `household-limits.env.spec.ts`: пусто → 5; `'3'` → 3; `'0'`, `'2.5'`, `'x'` → throw (по образцу `household-invites.env.spec.ts`).
  - e2e `household-lifecycle`: `rejects the sixth household`: у пользователя «Personal» + 4 созданных → 5-й `POST` (шестой бюджет) → 409, `body.reason === 'household_limit'`.
  - e2e `household-lifecycle`: `frees a slot when a household is deleted`: при 5 бюджетах удалить один созданный (204) → `POST /households` → 201.
  - e2e `household-invites`: `rejects accepting an invite at the household limit`: у invitee 5 бюджетов → accept → 409 `household_limit`; членства не появилось.
  - e2e `household-invites`: `answers already_member before the limit`: invitee уже участник бюджета и всего у него 5 → accept второго приглашения в тот же бюджет → 409 `already_member`.
  - int `test/household-concurrency.int-spec.ts` (`app.get(HouseholdService)`): `does not overshoot the limit under concurrent creates`: у пользователя 4 бюджета → `Promise.allSettled` из трёх `createHousehold` → ровно один fulfilled, у пользователя 5 бюджетов.
- [ ] **Step 2: Run** `npm test -- household-limits` и `npm run test:e2e -- household-lifecycle household-invites household-concurrency` — Expected: FAIL.
- [ ] **Step 3: Implement** env-провайдер в модуле, `household-locks.ts`, проверку в `createHousehold` (lock → count ≥ max → `limitReached()`) до вставки.
- [ ] **Step 4: Implement** в `acceptInvite`: после проверки `existing` (already_member) и проверок статуса/срока, до `insert`: `lockUserHouseholds(txEm, user.id)`, затем count ≥ max → `limitReached()`.
- [ ] **Step 5: Docs**: `.env.example` — закомментированная строка `# HOUSEHOLD_MAX_HOUSEHOLDS=5` с одной строкой пояснения рядом с `HOUSEHOLD_MAX_ACTIVE_INVITES`; Swagger 409 у `POST /households` и `POST /households/invites/accept`.
- [ ] **Step 6: Run** те же команды — Expected: PASS.
- [ ] **Step 7: Commit** `feat(households): limit the households a user belongs to (HAN-22)`.

### Task 3: Защита удаления

**Files:**
- Modify: `src/modules/household/household.service.ts` (`softDeleteHousehold`, `acceptInvite`), `src/modules/household/household.controller.ts` (передать `user.id`, Swagger 409/403)
- Test: `test/household-lifecycle.e2e-spec.ts`, `test/household-concurrency.int-spec.ts`, `src/modules/household/household.service.spec.ts`

**Interfaces:**
- Consumes: `lockUserHouseholds`, `countLiveMemberships` (Task 2).
- Produces: `softDeleteHousehold(hid: string, ownerId: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**
  - e2e: `rejects deleting the last household` → 409 `last_household`, бюджет на месте.
  - e2e: `rejects deleting a household with other members` (пригласить и принять второго пользователя, у owner есть второй бюджет) → 409 `household_has_members`.
  - e2e: `forbids a member from deleting` → 403.
  - e2e: `deletes a household` → 204, его нет в `GET /households`, `GET /households/:id` → 403.
  - e2e: `counts memberships in others' households`: owner A — участник бюджета B; у A один свой бюджет → удаление своего → 204.
  - int: `keeps one household under concurrent deletes`: у пользователя 2 бюджета → `allSettled` двух `softDeleteHousehold` → один fulfilled, один rejected `ConflictException`, живой бюджет один.
- [ ] **Step 2: Run** `npm run test:e2e -- household-lifecycle household-concurrency` — Expected: FAIL.
- [ ] **Step 3: Implement** `softDeleteHousehold(hid, ownerId)` в `transactional`: `lockUserHouseholds(txEm, ownerId)` → `findOne(Household, {id: hid, deleted_at: null}, {lockMode: PESSIMISTIC_WRITE})` (нет → 404) → `count(HouseholdMember, {household: hid})` > 1 → 409 `household_has_members` → `countLiveMemberships(txEm, ownerId)` ≤ 1 → 409 `last_household` → `deleted_at = new Date()`.
- [ ] **Step 4: Implement** в `acceptInvite` перед `insert` участника: `select 1 from households where id = ? and deleted_at is null for share` в `txEm`; нет строки → `GoneException({ reason: 'household_deleted' })`. `FOR SHARE` не конфликтует с `FOR KEY SHARE` от вставки чеков, но ждёт `FOR UPDATE` удаления — комментарий об этом рядом.
- [ ] **Step 5: Controller**: `deleteHousehold` берёт `@CurrentUser() user` и вызывает `softDeleteHousehold(hid, user.id)`; `@ApiConflictResponse` с обоими `reason`. Обновить unit-тест сервиса под новую сигнатуру.
- [ ] **Step 6: Run** `npm test -- household` и `npm run test:e2e -- household` — Expected: PASS.
- [ ] **Step 7: Commit** `feat(households): forbid deleting the last household or one with members (HAN-22)`.

### Task 4: Своё имя бюджета у участника

**Files:**
- Create: `src/migrations/Migration20261116100000_AddHouseholdMemberDisplayName.ts`
- Create: `src/modules/household/dto/update-my-household.dto.ts`
- Modify: `src/entities/household-member.entity.ts`, `src/modules/household/dto/household-response.dto.ts`, `src/modules/household/household.service.ts` (`toDto`, `createHousehold`, `getHousehold`, `updateHousehold`, новый метод), `src/modules/household/household.controller.ts`, `src/modules/household/index.ts` (экспорт DTO)
- Test: `test/household-lifecycle.e2e-spec.ts`

**Interfaces:**
- Produces: `HouseholdMember.display_name?: string | null` (`varchar(255)`, nullable).
- Produces: `UpdateMyHouseholdDto { display_name: string | null }` — `@ValidateIf(v !== null)`, `@Transform` trim, `@IsString()`, `@Length(1, 255)`; поле обязательно (отсутствие → 400).
- Produces: `HouseholdResponseDto.original_name: string`.
- Produces: `HouseholdService.updateMyHousehold(hid: string, userId: string, dto: UpdateMyHouseholdDto): Promise<HouseholdResponseDto>`.
- Produces: `toDto(h: Household, memberCount: number, displayName?: string | null): HouseholdResponseDto` — `name: displayName ?? h.name`, `original_name: h.name`.
- Changes: `getHousehold(hid, userId)`, `updateHousehold(hid, userId, dto)` — берут `display_name` строки участника `userId`.

- [ ] **Step 1: Write the failing tests** (e2e, бюджет owner с принятым участником):
  - `lets a member set their own name`: участник `PUT /households/:hid/me {display_name:'  Дом  '}` → 200, `name === 'Дом'`, `original_name` — основное; в `GET /households` и `GET /households/:hid` участника — `name 'Дом'`; у owner — основное.
  - `resets to the original name with null` → `name === original_name`.
  - `rejects a blank name`: `'   '` → 400; без поля → 400; 256 символов → 400.
  - `follows the original rename unless overridden`: owner `PUT /households/:hid {name:'Семья 2'}`; участник без своего имени видит `'Семья 2'`, со своим — своё.
- [ ] **Step 2: Run** `npm run test:e2e -- household-lifecycle` — Expected: FAIL (404 на `PUT :hid/me`).
- [ ] **Step 3: Migration** `alter table "household_members" add column "display_name" varchar(255) null;` / down — `drop column`. Поле в сущности.
- [ ] **Step 4: Implement** DTO, `updateMyHousehold` (`nativeUpdate` строки участника → вернуть `toDto`), контроллер `@Put(':hid/me')` с `HouseholdMemberGuard`, без `assertOwner`; `toDto` и вызывающие с `display_name`; Swagger `original_name` и операция.
- [ ] **Step 5: Run** `npm run migration:up`, `npm run migrations:lint`, `npm run migration:drift`, `npm test -- household`, `npm run test:e2e -- household` — Expected: PASS, дрейфа схемы нет.
- [ ] **Step 6: Commit** `feat(households): per-member household name (HAN-22)`.

### Task 5: Список бюджетов: счётчики одним запросом и сортировка

**Files:**
- Modify: `src/modules/household/household.service.ts` (`listHouseholds`), `src/modules/household/dto/household-response.dto.ts`, `src/modules/household/household.controller.ts`, `src/modules/household/index.ts`
- Test: `test/household-lifecycle.e2e-spec.ts`, `src/modules/household/household.service.spec.ts`

**Interfaces:**
- Consumes: `display_name` (Task 4).
- Produces: `HouseholdListItemDto extends HouseholdResponseDto { bill_count: number }`; `listHouseholds(userId): Promise<HouseholdListItemDto[]>`.

- [ ] **Step 1: Write the failing tests** (e2e):
  - `counts confirmed and draft bills only`: в бюджете 1 confirmed, 1 draft, 1 failed, 1 duplicate, 1 удалённый (вставка через SQL, как в `test/bill-delete.e2e-spec.ts`/`manual-batch.e2e-spec.ts`) → `bill_count === 2`; в пустом — 0.
  - `counts members`: бюджет с принятым участником → `member_count === 2`.
  - `orders households by creation`: созданные `A`, `B` после «Personal» → порядок `[Personal, A, B]`.
  - `skips deleted households` — удалённый не в списке.
- [ ] **Step 2: Run** `npm run test:e2e -- household-lifecycle` — Expected: FAIL (`bill_count` undefined).
- [ ] **Step 3: Implement** `listHouseholds` одним `this.em.getConnection().execute(...)`:

```sql
select h.id, h.name as original_name, coalesce(m.display_name, h.name) as name,
       h.currency, h.created_at,
       (select count(*) from household_members m2 where m2.household_id = h.id)::int as member_count,
       (select count(*) from bills b
         where b.household_id = h.id and b.deleted_at is null
           and b.status in ('confirmed', 'draft'))::int as bill_count
from   household_members m
join   households h on h.id = m.household_id
where  m.user_id = ? and h.deleted_at is null
order  by h.created_at asc, h.id asc
```

  `bill_count` использует `bills_household_status_date_index`. Убрать populate `household.members`; unit-тест `listHouseholds` переписать на мок `execute` или удалить в пользу e2e.
- [ ] **Step 4: Swagger**: `@ApiOkResponse({ type: [HouseholdListItemDto] })`, описание `bill_count` («confirmed + draft, без удалённых — для подтверждения удаления»).
- [ ] **Step 5: Run** `npm run test:e2e -- household-lifecycle household-currency household-isolation` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(households): bill and member counts in the household list (HAN-22)`.

### Task 6: Полная проверка

- [ ] **Step 1: Run** `npm run lint:check`, `npm run type-check`, `npm test`, `npm run test:e2e` — Expected: всё зелёное; упавшие тесты чинятся в той задаче, к которой относятся, отдельным коммитом.
- [ ] **Step 2: Swagger вручную**: поднять приложение, открыть `/api` (`SwaggerModule.setup('api', …)` в `src/app.setup.ts`), проверить `PUT /households/{hid}/me`, `original_name`, `bill_count`, 409 у create/accept/delete.
- [ ] **Step 3: Linear**: комментарий в HAN-22 со списком коммитов; PR в `dev` с `Fixes HAN-22` — только по команде владельца.
