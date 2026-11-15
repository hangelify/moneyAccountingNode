# HAN-24 — Лимиты по категориям: модель и CRUD

Linear: [HAN-24](https://linear.app/hangelify/issue/HAN-24) · эпик [HAN-21](https://linear.app/hangelify/issue/HAN-21) · следующая задача [HAN-25](https://linear.app/hangelify/issue/HAN-25) (отчёт)
Дата: 2026-11-15 · Статус: одобрено владельцем 2026-11-15

## Зачем

Пользователь хочет поставить цель «на Еду не больше 400 € в месяц» и потом (HAN-25)
видеть, уложился ли он, в том числе за прошлые периоды. Для этого нужен лимит на
категорию верхнего уровня с повторяющимся календарным периодом и **историей версий**:
прошлый период должен считаться по тому лимиту, который тогда действовал.

Старые `Budget → PlaningHorizon` для этого не годятся (один лимит на группу категорий,
нет даты начала и истории, фронт их не использует) и удаляются.

## Цели

- Таблица `category_limits` с версиями: у каждой версии свой интервал `[effective_from, effective_to)`.
- CRUD `/households/:hid/category-limits`.
- Модель, из которой HAN-25 одним запросом находит версию лимита для любого периода.
- Удалены модули, сущности, DTO и таблицы `budgets`, `planing_horizons`, `planing_horizon_categories`.

## Не цели

- Отчёт исполнения (HAN-25), фронт (HAN-28/29).
- Лимиты на подкатегории, общий лимит бюджета, разовые лимиты с произвольными датами.
- Кастомный старт года/квартала, роли (кто может задавать лимиты — HAN-9).
- Изменение лимита задним числом на произвольную дату (клиент дату не передаёт).

## Анти-цели

- Две версии одной категории, действующие в один день (отчёт задвоит лимит).
- Тихая потеря данных старых таблиц на проде.

## Решения владельца (2026-11-15)

1. **Изменение лимита — с начала текущего периода нового типа (вариант А).** Пересекающиеся
   версии переписываются: прошлые периоды, попавшие в окно, считаются по новой версии.
2. **Удаление — лимит доживает до конца текущего периода (вариант Б).**
3. **Подход — логика версий в сервисе, одна транзакция с блокировкой** (вариант 1, см. «Подходы»).
4. Подтверждены предложения: валюта хранится в лимите; новый enum; права — любой участник;
   `planing_horizon_id` убирается из API категорий; миграция падает на непустых старых таблицах.

## Модель

### Таблица `category_limits`

| Колонка | Тип | Примечание |
|---|---|---|
| `id` | uuid PK | как `BaseEntity` |
| `household_id` | uuid FK → households, `on delete cascade` | денормализовано для запросов отчёта |
| `category_id` | uuid FK → categories, `on delete cascade` | только категория верхнего уровня (других и нет) |
| `period_type` | `limit_period_type` enum | `MONTHLY`, `QUARTERLY`, `SEMI_ANNUAL`, `YEARLY` |
| `amount` | `decimal(19,2)` | `> 0` (CHECK). Ноль не разрешаем: «лимит 0» = снять лимит |
| `currency` | `currency_enum` | валюта бюджета на момент создания версии |
| `effective_from` | `date` | первый день действия, всегда начало периода своего типа |
| `effective_to` | `date null` | первый день, когда уже **не** действует; `null` = открыта |
| `created_by_id` | uuid FK → users, `on delete set null`, nullable | кто создал версию |
| `created_at`, `updated_at` | timestamptz | |

Ограничения и индексы:

- `CHECK (effective_to IS NULL OR effective_to > effective_from)`
- `CHECK (amount > 0)`
- partial unique `category_limits_category_open_unique` on `(category_id) WHERE effective_to IS NULL` — одна **открытая** версия на категорию.
- index `(household_id, category_id, effective_from)` — для отчёта и `GET`.

Отсутствие перекрытий версий одной категории — **инвариант сервиса** (база его не проверяет,
см. «Подходы»), закреплён тестами.

### Термины

- **Открытая** версия: `effective_to IS NULL`.
- **Доживающая**: `effective_to > today` (удалена, но ещё действует до конца периода).
- **Действующая сегодня** (`current`): `effective_from <= today AND (effective_to IS NULL OR effective_to > today)`.
- `today` — UTC-дата сервера (`todayIsoDate()`), как в `period-range.ts`. *(Моё решение;
  у пользователя в UTC+2 правка в 00:00–02:00 первого числа попадёт в прошлый месяц — допустимо.)*

### Границы периодов

Календарные, half-open `[start, end)`:

- `MONTHLY` — месяц; `QUARTERLY` — янв/апр/июл/окт; `SEMI_ANNUAL` — янв/июл; `YEARLY` — янв.

Функции `limitPeriodStart(type, date)` и `limitPeriodEnd(type, date)` — рядом с
`computePeriodRange` в `src/common/utils/period-range.ts` (там же добавить полугодие); HAN-25
использует их же.

### Какая версия относится к периоду (для HAN-25)

Для периода `[P, P_end)` типа T берётся версия с `period_type = T` и
`effective_from <= P AND (effective_to IS NULL OR effective_to > P)`.
Так как версии не перекрываются, их не больше одной. Версии другого типа в этот период
не попадают — это следствие варианта А (см. пример ниже).

## Правила изменения

Все записи (`POST`, `PUT`, `DELETE`, мягкое удаление категории) идут через одну функцию
сервиса. Её «мозг» — чистая функция без БД:

```ts
planLimitChange(versions: LimitVersion[], change: Change, today: string): {
  delete: string[];                         // id версий
  update: { id: string; effective_to: string }[];
  insert?: NewVersion;
}
```

где `versions` — версии категории, у которых `effective_to IS NULL OR effective_to > S`
(остальные — неизменная история).

### Установить лимит (`POST` и `PUT`) — вариант А

`S = limitPeriodStart(newType, today)`.

1. Версии с `effective_from >= S` — **удалить** (новая их полностью перекрывает).
2. Версия, внутри которой лежит `S` (`effective_from < S` и `effective_to` null или `> S`) — `effective_to = S`.
3. Вставить `{type, amount, currency = household.currency, effective_from: S, effective_to: null}`.

Частный случай «изменили дважды за период»: открытая версия уже начинается с `S` → шаг 1
удаляет её, шаг 3 вставляет новую. *(Моё решение: удалить+вставить, а не UPDATE на месте —
один путь кода; id версии меняется, клиент адресует лимит по `category_id`, так что это не мешает.)*

Идемпотентность — только для `PUT`: если новая версия совпадает с открытой по `type`, `amount`
и `currency` и та начинается с `S` — ничего не меняем, отвечаем 200 с текущим состоянием.
`POST` при открытой версии **всегда** 409, даже если тело совпадает (проверка до `planLimitChange`).
*(Моё решение: у `POST` один смысл — «у категории лимита нет»; повтор после сбоя сети клиент
распознаёт по 409 и перечитывает `GET`.)*

**Пример.** Версии: V1 «месяц 300» `[2026-09-01, 2026-11-01)`, V2 «месяц 350» `[2026-11-01, ∞)`.
15 ноября ставим «квартал 1000» → `S = 2026-10-01`. V2 удаляется, V1 → `[2026-09-01, 2026-10-01)`,
V3 «квартал 1000» `[2026-10-01, ∞)`. Отчёт: сентябрь (месяц) — 300; октябрь и ноябрь как
месяцы — без лимита; Q4 — 1000.

**Обратная смена** (квартал → месяц 15 ноября): `S = 2026-11-01`, квартальная версия
закрывается `2026-11-01`. Q4 как квартал — по старой квартальной; октябрь как месяц — без
лимита; ноябрь как месяц — новый.

### Снять лимит (`DELETE`) — вариант Б

Только для открытой версии (иначе 404). `E = limitPeriodEnd(version.type, today)`.

- `effective_from >= E` невозможно (версия открыта с начала текущего или прошлого периода).
- Иначе `effective_to = E`. Лимит действует до конца текущего периода своего типа.

### Повторное создание после удаления

`POST` на категорию с доживающей версией разрешён (partial unique её не видит) и идёт по
правилу «Установить лимит»: доживающая версия обрезается или удаляется. Отдельного случая нет.

### Мягкое удаление категории

`CategoryService.deleteCategory` в той же транзакции применяет к открытой версии правило
`DELETE` (доживает до конца периода). Траты по архивной категории в отчёт попадают и так.

### Конкурентность

Функция записи: `em.transactional` → `SELECT … FROM categories WHERE id = ? AND household_id = ?
AND deleted_at IS NULL FOR UPDATE` (`LockMode.PESSIMISTIC_WRITE`, как в `bill-duplicates.service.ts`)
→ чтение версий → `planLimitChange` → запись. Два одновременных запроса на одну категорию
выполняются по очереди; partial unique — вторая страховка от двух открытых версий.

## API

Все эндпоинты — `@UseGuards(JwtAuthGuard, HouseholdMemberGuard)`, любой участник бюджета.
Контроллер `households/:hid/category-limits`, модуль `src/modules/category-limit/`.

| Метод | Путь | Тело / query | Ответ | Ошибки |
|---|---|---|---|---|
| `GET` | `/category-limits` | `?include_history=true` | `CategoryLimitDto[]` | — |
| `POST` | `/category-limits` | `{category_id, period_type, amount}` | 201 `CategoryLimitDto` | 404 категория не в бюджете/удалена; 409 у категории уже есть открытый лимит; 400 валидация |
| `PUT` | `/category-limits/:categoryId` | `{period_type, amount}` | 200 `CategoryLimitDto` | 404 нет открытого лимита (в т. ч. доживающий) |
| `DELETE` | `/category-limits/:categoryId` | — | 200 `CategoryLimitDto` (с `effective_to`) | 404 нет открытого лимита |

- Без `include_history` — версии, **действующие сегодня** (открытые и доживающие), по
  одной на категорию. С `include_history=true` — все версии бюджета, `category_id, effective_from` по возрастанию.
- `DELETE` отвечает 200 с телом, а не 204: клиенту нужна дата `effective_to`, чтобы показать «действует до …». *(Моё решение.)*
- `amount` — число, `> 0`, не больше `MAX_MONEY_AMOUNT` (`src/common/utils/money.util.ts`), 2 знака.
- Валюта в запросе не принимается — всегда валюта бюджета на момент записи.

`CategoryLimitDto`:

```ts
{
  id: string;
  category_id: string;
  category_name: string;
  category_archived: boolean;
  period_type: 'MONTHLY' | 'QUARTERLY' | 'SEMI_ANNUAL' | 'YEARLY';
  amount: number;
  currency: Currency;
  effective_from: string;        // YYYY-MM-DD
  effective_to: string | null;   // YYYY-MM-DD, первый день без лимита
}
```

## Валюта

Версия хранит валюту бюджета на момент записи. Смена валюты бюджета старые версии не трогает;
отчёт (HAN-25) пересчитывает лимит в текущую валюту бюджета по курсу на начало периода.
Следующая правка лимита создаёт версию уже в новой валюте.

## Удаление старых сущностей

- Удалить: `src/modules/budget`, `src/modules/planing-horizon`, `src/entities/budget.entity.ts`,
  `planing-horizon.entity.ts`, `planing-horizon-category.entity.ts`, `src/types/period-type.enum.ts`,
  импорты в `app.module.ts`, связь `Category.planingHorizons`.
- **API категорий:** убрать обязательный `planing_horizon_id` из `CreateCategoryDto` и
  `BulkCreateCategoryDto` и проверку горизонта в `CategoryService.createCategory`/`bulkCreateCategories`.
  Ломающее изменение API, но фронт эти эндпоинты не вызывает (использует только `list`).
- `src/modules/category/category.module.ts` — убрать регистрацию сущности `PlaningHorizon`.
- `src/modules/bill/dto/money-bounds.dto.spec.ts` — убрать проверки `Create/UpdatePlaningHorizonDto`,
  добавить такие же для DTO лимитов.
- `CategoryService.deleteCategory` сейчас без транзакции и блокировки — обернуть в
  `em.transactional` с той же блокировкой строки категории, что у лимитов (новая работа).
- Пройтись поиском по `seeders`, тестам (`soft-delete-consistency.int-spec.ts`,
  `recent-categories.int-spec.ts`, `household-member.guard.wiring.spec.ts`, `module-loading.spec.ts`).

## Миграция

Одна миграция `…_ReplaceBudgetsWithCategoryLimits`:

**up**
1. Проверка: если в `budgets` или `planing_horizons` есть строки (включая мягко удалённые) —
   `RAISE EXCEPTION` с текстом «… rows found, export them before HAN-24 migration». Ничего не удаляется.
   Владелец подтвердил (2026-11-15): на проде таблицы пустые, экспорт не нужен; проверка
   остаётся страховкой для других окружений.
2. `DROP TABLE planing_horizon_categories, planing_horizons, budgets`; `DROP TYPE period_type_enum`
   (если больше нигде не используется — проверить).
3. `CREATE TYPE limit_period_type`, `CREATE TABLE category_limits` с ограничениями и индексами.

**down** — обратное: удалить `category_limits` и `limit_period_type`, восстановить схему старых
таблиц (без данных) по последним миграциям, создавшим их.

`migration:check` и `migration:drift` должны быть чистыми.

## Подходы (рассмотрены)

1. **Логика в сервисе, транзакция с блокировкой строки категории** — *выбран*. Как устроен
   проект, без расширений, без дрейфа снапшота. Минус: отсутствие перекрытий держится на коде и тестах.
2. **То же + `EXCLUDE USING gist` на `daterange`** — сильнейшая гарантия, но первое расширение
   (`btree_gist`) в проекте и ограничение, которое MikroORM не описывает в сущности → дрейф снапшота (HAN-10).
3. **Неизменяемый журнал событий, границы через `lead()`** — перекрытия невозможны, но вариант А
   превращается в правила старшинства событий, отчёт и CRUD сложнее.

## Тесты

**Юнит** (`planLimitChange`, `limitPeriodStart/End`):
- границы всех 4 типов, включая 31-е число, февраль, декабрь → январь;
- установка на пустой категории; изменение суммы в том же периоде; изменение в следующем периоде;
- смена типа месяц → квартал (пример выше) и квартал → месяц;
- повторное создание после удаления в том же и в следующем периоде;
- идемпотентный повтор;
- свойство: после любой последовательности изменений версии одной категории не перекрываются
  и каждая `effective_from` — начало периода своего типа.

**int** (`category-limit.int-spec.ts`):
- создание → 201; второй `POST` при открытом → 409; `POST` после `DELETE` → 201;
- `PUT` создаёт новую версию, история видна с `include_history`;
- `DELETE` ставит `effective_to` = начало следующего периода, лимит виден в `GET` до этой даты;
- категория другого бюджета / удалённая → 404; не участник → 403;
- мягкое удаление категории закрывает её лимит;
- два параллельных `POST` → ровно одна открытая версия;
- миграция падает на непустых `budgets`.

## Оставлено исполнителю

- Имена файлов, DTO, декораторов Swagger — по образцу модуля `category`.
- Как подменять `today` в тестах (параметр `now`, как у `computePeriodRange`).
- Нужен ли `GET /category-limits/:categoryId` — не нужен фронту сейчас; не делать.
