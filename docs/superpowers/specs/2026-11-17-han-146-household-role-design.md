# HAN-146 — роль пользователя в ответах о бюджете

Linear: [HAN-146](https://linear.app/hangelify/issue/HAN-146) · эпик HAN-21 · разблокирует фронт HAN-26.

## Зачем

Страница «Бюджеты» (HAN-26) показывает владельцу правку и удаление, участнику — только чтение.
`GET /households` роль вызывающего не отдаёт, поэтому фронт сейчас узнаёт её по 403 после клика
(`HouseholdEditor`), а после мутаций угадывает (`role: 'owner'` при создании, `saved.role ?? h.role`).

## Цели

- `role: 'owner' | 'member'` — роль **вызывающего** в этом бюджете — во **всех** ответах о бюджете:
  `GET /households` (список), `POST /households`, `PUT /households/:hid`, `PUT /households/:hid/me`.
  `GET /households/:hid` наследует поле от `HouseholdResponseDto`.
- Список остаётся одним SQL-запросом.

## Не цели

- Изменение прав, guard'ов или модели членства (HAN-9).
- Правки фронта (убрать догадки и fallback по 403 — отдельная задача `[F]`).

## Подход (выбран владельцем)

Рассматривали: (а) роль только в списке — минимум тикета, но фронт продолжает угадывать роль после
мутаций; (б) роль во всех ответах — +несколько строк, единая схема. **Выбрано (б).**

## Дизайн

- `HouseholdResponseDto.role` — `@ApiProperty({ enum: ['owner','member'], description: "The caller's role in this household" })`.
  `HouseholdListItemDto` и `HouseholdDetailResponseDto` наследуют.
- `listHouseholds`: в SQL добавить `m.role` (строка `m` — уже членство вызывающего).
- `toDto(h, memberCount, role, displayName?)` — роль обязательный аргумент:
  - `createHousehold` → `'owner'`;
  - `toResponse` → `mine.role` (членство уже загружено; отсутствие `mine` после guard'а невозможно —
    кидать ошибку, а не подставлять значение);
  - `getHousehold` → роль вызывающего из `members`.
- Совместимость: поле только добавляется; фронт уже принимает его (`role?` в `HouseholdResponse`).

## Критерии готовности

- e2e: в списке у создателя `role = 'owner'`, у принявшего приглашение — `'member'`;
  `POST` → `'owner'`; `PUT :hid/me` участника → `'member'`; `GET :hid` → роль вызывающего.
- Swagger показывает поле с описанием.
- unit-тесты сервиса обновлены под новую сигнатуру.

## Оставлено исполнителю

Точная формулировка ошибки при отсутствии своего членства в `toResponse`; в какой e2e-файл класть
проверки (предпочтительно `household-lifecycle.e2e-spec.ts`, где есть хелперы `listHouseholds`/`join`).
