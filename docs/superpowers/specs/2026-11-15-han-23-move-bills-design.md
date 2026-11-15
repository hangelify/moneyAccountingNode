# HAN-23 — перенос чеков между бюджетами с ремапом категорий и магазина

Linear: [HAN-23](https://linear.app/hangelify/issue/HAN-23) · эпик HAN-21 · фронт HAN-27 зависит от этой задачи.
Размер: проект (новый эндпоинт, свой сервис, транзакция с блокировками, SQL-ремап).

## Зачем

Пользователь раскладывает чеки по бюджетам («Семья», «Отпуск», «Ремонт») — по одному и пачкой. Категории,
подкатегории и магазины у каждого бюджета свои (решение владельца по эпику), поэтому перенос — это не смена
`household_id`, а пересопоставление связей по именам. Фронт (HAN-27) после переноса показывает тост «перенесено N
чеков, M позиций без категории» и понятный текст для 409.

## Что уже есть (на ba63114, origin/dev)

- **HAN-6 сделан.** `MarketService.findOrCreate(em, householdId, dto)` — `INSERT … ON CONFLICT DO NOTHING` +
  повторный `SELECT`, работает в транзакции вызывающего, без гонок.
- **HAN-47 сделан (кроме HAN-96).** У позиции своя `bill_sub_categories.category_id`; позиция может быть
  «категория без подкатегории». Инвариант: если `sub_category_id` задан, `category_id` = категория этой подкатегории.
- `template_id` (HAN-58) в коде ещё нет — сопоставление только по имени.
- **Фото.** Ключ `ai/images/<householdId>/<sha>.<ext>` (`StorageService.put`). Из S3 код ничего не удаляет.
  `getDraftImageKey` ищет чек по `bill.household` и берёт `bill.image_key ?? ai_request.image_s3_keys[0]` — после
  смены `household` фото открывается из целевого бюджета, ключ менять не нужно.
- **Уникальности, которые может нарушить перенос:**
  - `bills_household_image_sha256_draft_unique` — один открытый черновик на фото в бюджете;
  - `bills_household_client_batch_unique` — `(household_id, client_batch_id, client_batch_index)`.
- **Дубликаты.** `bills.duplicate_of_id` (CHECK: задан ⇔ `status = duplicate`); `bill_duplicate_dismissals`
  (`household_id`, пара `bill_id < other_bill_id`) — пары «это не дубликат».
- **Блокировки.** `updateBill`, `confirmBill`, `softDeleteBill`, `markDuplicate` и др. берут
  `LockMode.PESSIMISTIC_WRITE` на чек; `markDuplicate` — по двум чекам в порядке `id asc`.
- **Курсы.** `BillCrudService.warmRate` после коммита сохраняет курс дня чека, если валюта чека ≠ валюте бюджета;
  дашборд при отсутствии курса относит чек к неконвертированным (`household-conversion.ts`).
- **Права.** `@UseGuards(JwtAuthGuard, HouseholdMemberGuard)` на `households/:hid/bills`; роли `owner`/`member`
  для действий с чеками не используются. Гейт подтверждённого email — общий, в `JwtAuthGuard`.
- **Журнал.** Сущность `Log` (`level`, `source`, `context`, `message`, `metadata jsonb`, `user`, `endpoint`…);
  пишет пока только `AuthService` через `EntityRepository<Log>`.

## Цели / не цели / анти-цели

**Цели:** перенос 1–100 чеков одним запросом, всё или ничего; ремап категорий, подкатегорий и магазина в целевой
бюджет; в ответе — что перенесено и сколько позиций потеряли подкатегорию / категорию.

**Не цели:**
- создание недостающих категорий/подкатегорий в целевом бюджете (API оставляем расширяемым);
- сопоставление по `template_id` (появится с HAN-58);
- видимый след переноса в исходном бюджете — это HAN-140 (решение владельца 2026-11-15);
- ограничения по ролям (HAN-9);
- перенос `failed` и `duplicate` чеков; перенос «всех по фильтру»;
- изменения фронта (HAN-27).

**Анти-цели:** чек «наполовину» перенесён (часть позиций в старых категориях); позиция ссылается на категорию
чужого бюджета; гонка с параллельными confirm/update/delete/mark-duplicate.

## Решения владельца (2026-11-15)

1. **Ремап категорий** — пара, затем категория:
   - есть в целевом бюджете живая пара `lower(category.name)` + `lower(sub_category.name)` → обе связи на неё;
   - пары нет, но есть живая категория с тем же `lower(name)` → позиция в этой категории **без подкатегории**;
   - нет и категории → позиция без категории (`category_id = null`, `sub_category_id = null`);
   - позиция «только категория» → по имени категории; позиция без категории остаётся без категории.
2. **Кто переносит:** любой участник **обоих** бюджетов (как и прочие действия с чеками).
3. **След:** в бюджете не остаётся; только запись в журнале `logs`. Видимый след для владельца — HAN-140.

## Подходы

- **1. Отдельный `BillMoveService`, ремап одним SQL-запросом (выбран владельцем).** Транзакция: блокировка
  чеков, проверки, один `UPDATE bill_sub_categories … FROM` с `LEFT JOIN` на категории/подкатегории целевого
  бюджета, `RETURNING` для счётчиков. Быстро на пачке, логика переноса в одном месте, `bill-crud.service.ts`
  не растёт. Минус: ремап на SQL проверяется int-тестами.
- 2. То же, ремап в TypeScript через ORM (чистая функция + `flush`). Отвергнут: больше кода и запросов,
  UPDATE на каждую позицию.
- 3. Метод в `BillCrudService`. Отвергнут: файл ~1000 строк, у переноса свои блокировки и проверки.

## Дизайн

### 1. API

`POST /households/:hid/bills/move` — в `BillController` (класс уже под `JwtAuthGuard`, `HouseholdMemberGuard`
по исходному `:hid`). Объявить до маршрутов с `:id`, хотя конфликта с `POST :id/confirm` нет.

```ts
class MoveBillsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique() @IsUUID('4', { each: true })
  bill_ids!: string[];
  @IsUUID('4') target_household_id!: string;
}
```

Ответ `200`:

```ts
class MoveBillsResponseDto {
  target_household_id: string;
  bills: MovedBillDto[]; // в порядке bill_ids
}
class MovedBillDto {
  id: string;
  lines_total: number;            // позиций в чеке
  lines_lost_sub_category: number; // была подкатегория → осталась только категория
  lines_lost_category: number;     // была категория → стала без категории
  already_moved: boolean;          // чек уже был в целевом (повтор запроса); счётчики 0
}
```

Ошибки:

| Код | Когда |
|---|---|
| 400 | валидация DTO; `target_household_id = :hid` |
| 403 | пользователь не участник целевого бюджета, или целевой удалён/не существует (как в guard — не различаем) |
| 404 | хотя бы один `bill_id` не найден живым ни в исходном, ни в целевом бюджете; тело — список id |
| 409 | хотя бы один чек нельзя перенести; тело — `{ conflicts: [{ id, reason }] }`, все проблемные сразу |

Причины 409 (`reason`):
- `status_not_movable` — `failed` или `duplicate`;
- `has_duplicates` — на чек ссылается живой чек со `status = duplicate` (`duplicate_of_id = id`);
- `draft_image_conflict` — черновик, а в целевом есть живой черновик с тем же `image_sha256`;
- `client_batch_conflict` — в целевом есть чек с тем же `(client_batch_id, client_batch_index)` (удалённые
  тоже — индекс не частичный по `deleted_at`).

Swagger: `@ApiOperation`, описания полей, все коды выше — в `dto/api-responses.decorator.ts` по образцу соседних.

### 2. `BillMoveService.move(sourceHid, userId, dto)`

Новый файл `src/modules/bill/bill-move.service.ts`, провайдер `BillModule`. Зависимости: `EntityManager`,
`MarketService`, `ExchangeRateService` (для прогрева после коммита), `EntityRepository<Log>`.

В `em.transactional`:

1. **Членство в целевом.** `household_members` по `(target, userId)` + `households.deleted_at IS NULL`; нет → 403.
   Проверка — та же логика, что в `HouseholdMemberGuard`; вынести общий запрос в `HouseholdService`/хелпер
   модуля `household` (экспорт через `index.ts`), не дублировать SQL.
2. **Блокировка чеков.** `SELECT … FROM bills WHERE id = ANY(?) AND household_id IN (sourceHid, target)
   AND deleted_at IS NULL ORDER BY id FOR UPDATE` (порядок `id asc` — как в `markDuplicate`, против дедлоков).
   - Чек уже живёт в целевом бюджете — **уже перенесён** (повтор запроса после таймаута): в ответе с нулевыми
     счётчиками, ничего с ним не делаем.
   - Не найден ни в исходном, ни в целевом → 404 со списком отсутствующих.
   - Все чеки уже в целевом → 200 без изменений и без записи в журнал.
3. **Проверки** (собрать все конфликты, затем одно 409): статус, `has_duplicates`, `draft_image_conflict`,
   `client_batch_conflict` — по одному запросу на вид проверки для всей пачки. Два черновика пачки с одним
   `image_sha256` невозможны (уже уникальны в исходном).
4. **Магазины.** Уникальные `lower(market.name)` живых магазинов переносимых чеков; для каждого —
   `markets.findOrCreate(em, target, { name, city, country, address })` в порядке имени (стабильный порядок
   вставок против дедлоков с параллельным переносом). Чек с удалённым магазином или без магазина → `market = null`
   (удалённый магазин не воскрешаем в целевом — решение Claude, см. «Решения Claude»).
5. **Ремап позиций** — один запрос, условие по `bill_id = ANY(?)`:

   ```sql
   UPDATE bill_sub_categories bsc
   SET    category_id     = tc.id,
          sub_category_id = tsc.id,
          category_confidence = CASE WHEN <потеря> THEN NULL ELSE bsc.category_confidence END,
          category_reasoning  = CASE WHEN <потеря> THEN NULL ELSE bsc.category_reasoning END
   FROM   bill_sub_categories old
   LEFT JOIN categories     sc  ON sc.id  = old.category_id
   LEFT JOIN sub_categories ssc ON ssc.id = old.sub_category_id
   LEFT JOIN categories     tc  ON tc.household_id = :target AND tc.deleted_at IS NULL
                               AND lower(tc.name) = lower(sc.name)
   LEFT JOIN sub_categories tsc ON tsc.category_id = tc.id AND tsc.deleted_at IS NULL
                               AND lower(tsc.name) = lower(ssc.name)
   WHERE  bsc.id = old.id AND old.bill_id = ANY(:ids)
   RETURNING bsc.bill_id,
             old.sub_category_id IS NOT NULL AND tsc.id IS NULL AND tc.id IS NOT NULL AS lost_sub,
             old.category_id     IS NOT NULL AND tc.id IS NULL                       AS lost_cat
   ```

   «Потеря» = `lost_sub OR lost_cat`. Категория/подкатегория источника, удалённая мягко, всё равно сопоставляется
   по имени (имя исторически верно); в целевом матчим только живые. Уникальные индексы `lower(name)` на живых
   гарантируют не больше одного совпадения. Если `bsc.category_id` был `null`, `tc` пуст → остаётся `null`.
   Итоговый SQL builder уточняет сам (self-join `old` нужен, чтобы `RETURNING` видел старые значения).
6. **Чеки.** `UPDATE bills SET household_id = :target, market_id = <из п.4>, updated_at = now()` по пачке.
   Не трогаем: `currency`, `amount`, `status`, `source`, `image_key`, `image_sha256`, `ai_request_id`,
   `created_by`, `confirmed_by`, `client_batch_*`, `fiscal_*`.
7. **Отметки дубликатов.** `DELETE FROM bill_duplicate_dismissals WHERE bill_id = ANY(:ids) OR other_bill_id = ANY(:ids)`.
8. **Журнал.** Одна запись `Log` на запрос: `level INFO`, `source API`, `context 'BillMove'`, `user`,
   `message 'Moved N bill(s) to household <target>'`, `metadata { source_household_id, target_household_id,
   bill_ids, lost: [{ id, sub, cat }] }`. Пишется в той же транзакции (откат — без записи).

После коммита: прогрев курсов — для чеков с `currency ≠ target.currency` вызвать
`exchangeRates.ensureDays(уникальные bill_date, { max: days.length })`, не бросая. Почти готовый образец для пачки —
`ManualBillBatchService.warmRates` (`manual-bill-batch.service.ts`); вынести из него общий хелпер и
использовать в обоих местах. Нет курса → дашборд целевого покажет чек в неконвертированных, это ожидаемо.

### 3. Что не меняется

- `ai_requests.household_id` — история запроса, остаётся исходным. `getDraftImageKey` читает `ai_request` через
  чек, не по household.
- `bill_batches` / `bill_batch_items` остаются в исходном бюджете; `GET` статуса пакета отдаст `bill_id` чека,
  ушедшего в другой бюджет, — фронт получит 404 при переходе. Допустимо (решение Claude).
- Файлы в S3.
- Мягко удалённые дубликаты, ссылающиеся на переносимый чек, остаются в исходном бюджете со своим
  `duplicate_of_id` (ссылка между бюджетами). Код это уже допускает: `linkAsDuplicate` намеренно перенаправляет
  и удалённые, `promoteAfterDelete` не фильтрует по бюджету; восстановления удалённых нет. Обнулить нельзя —
  CHECK `bills_duplicate_of_check`. Проверка `has_duplicates` смотрит только живые.

## Решения Claude (владелец может поправить)

- **Повтор запроса** после успешного переноса — 200, чек помечен `already_moved`, а не 404: фронт (HAN-27)
  покажет тост, а не ошибку. Ключ идемпотентности не вводим — состояние «чек уже в целевом» и есть ключ.
- **Удалённый магазин** у переносимого чека в целевом не воскрешаем → `market = null`.
- **Удалённые дубликаты** — ссылку оставляем как есть (см. выше).
- **Пакеты загрузки** (`bill_batches`) остаются в исходном бюджете; статус пакета может отдать `bill_id`
  перенесённого чека, переход на него даст 404.
- **Предел пачки** — 100 чеков.

## Мелочи для плана

- `HouseholdService` не экспортируется из `household/index.ts` и `HouseholdModule` (экспортируется только
  guard) — для проверки членства в целевом добавить экспорт или отдельный хелпер.
- `Log` нет в `MikroOrmModule.forFeature` у `BillModule` — добавить.

## Тесты

int-тесты (`bill-move.int-spec.ts`, реальная БД, как соседние `*.int-spec.ts`):

- ремап: пара найдена; только категория найдена → `sub_category_id = null`, `lost_sub`; ничего → обе `null`,
  `lost_cat`; позиция «только категория»; позиция без категории; регистр имён (`Еда` ↔ `еда`); удалённая категория
  в целевом не матчится; `category_confidence`/`reasoning` обнулены только у потерявших;
- магазин: найден в целевом (по регистру) / создан с city/country/address; без магазина → `null`;
- 403 без членства в целевом; 403 на удалённый целевой; 400 на `target = :hid`; 404 на чужой/удалённый id;
- 409: `failed`, `duplicate`, оригинал с дубликатами, конфликт `image_sha256` черновика, конфликт `client_batch`;
  в 409 перечислены все проблемные, и **ничего не изменилось** (всё или ничего);
- отметки `bill_duplicate_dismissals` удалены;
- дашборд и список: чек пропал в исходном, появился в целевом; чек в валюте ≠ валюте целевого без курса — в
  неконвертированных;
- `drafts/:id/image` перенесённого черновика отдаёт фото из целевого;
- запись в `logs`;
- повтор того же запроса → 200, `already_moved: true`, данные не изменились; смесь «уже в целевом» + новые
  чеки переносит только новые;
- мягко удалённый дубликат переносимого чека не мешает переносу и остаётся в исходном.

unit: `MoveBillsDto` (размер, uuid, уникальность); контроллер передаёт `hid`, `user.id`.

## Что остаётся builder'у

- Точный SQL ремапа и проверок, форма тела 404/409 по образцу существующих исключений.
- Где именно живёт проверка членства (общий хелпер модуля `household`).
- Имя и место хелпера прогрева курсов.
