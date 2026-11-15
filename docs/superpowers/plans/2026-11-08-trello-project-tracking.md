# Trello project tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поднять Trello-доску проекта по спеке, записать правила для Claude
в `CLAUDE.md` обоих репозиториев, отметить релизы v0.1.0 и наполнить доску
стартовыми карточками.

**Architecture:** Кода нет — работа идёт через Trello MCP-коннектор
(`mcp.trello.com`) и git. «Тест» каждой задачи — чтение созданного обратно
через коннектор / git и сверка с ожидаемым списком. Все ID Trello-объектов
фиксируются в `CLAUDE.md` и дальше используются только по ID, не по имени.

**Tech Stack:** Trello MCP connector, git, Trello GitHub Power-Up.

**Spec:** `docs/superpowers/specs/2026-11-08-trello-project-tracking-design.md`

## Global Constraints
- Репозитории: сервер `accounting_node/accounting` (`hangelify/moneyAccountingNode`,
  ветки `dev`/`main`); фронт `accounting_react` (`hangelify/moneyAccountingReact`,
  ветки `dev`/`master` — у фронта основная ветка `master`, не `main`).
- `/docs` и `CLAUDE.md` в `.gitignore` обоих репозиториев: эти файлы локальные,
  не коммитятся, PR для них не нужен.
- Git-теги: `vX.Y.Z` без префикса. Префиксы `server`/`front` — только в именах
  списков и карточек на доске.
- Имя доски: `moneyAccounting`. Язык доски — русский.
- Списки, метки, поля, шаблон карточки — ровно как в разделах спеки
  «Списки», «Метки», «Custom Fields», «Карточка».
- Push тегов и любые действия, которые спека относит к согласию пользователя,
  — только после явного «да» в чате.

## Review Focus
1. Повторный запуск задачи (сессия оборвалась посреди) не должен создавать
   дубли списков/меток/полей/карточек — каждая задача сначала читает доску и
   создаёт только отсутствующее.
2. Custom Fields недоступны на тарифе или в коннекторе — включается fallback
   спеки (метки `sv0.1.0`/`fv0.1.0`, ссылки в описании), и это записано в
   `CLAUDE.md`, иначе следующие сессии будут искать несуществующие поля.
3. ID карточки для веток — это числовой `idShort` (`#42`), не `shortLink`
   (`aB3dE9xY`); перепутать — ветки не найдутся по карточке.
4. Тег `v0.1.0` на сервере ставится только на коммит, который реально
   задеплоен; если `origin/main` ушёл дальше задеплоенного — остановиться и
   спросить.
5. Переименование списка в Trello (эмодзи, опечатка) не ломает автоматику —
   `CLAUDE.md` ссылается на ID.

---

### Task 0: Предусловия

- [ ] **Step 1:** Проверить, что инструменты Trello-коннектора доступны в
  сессии (`trelloReadWorkspace` и пр.). Если нет — остановиться, попросить
  пользователя подключить коннектор Trello в настройках коннекторов.
- [ ] **Step 2:** Прочитать workspaces пользователя; спросить, в каком
  создавать доску (если workspace один — взять его, сказать об этом).
- [ ] **Step 3:** Проверить, нет ли уже доски `moneyAccounting` в этом
  workspace. Есть — работать с ней (Review Focus 1), не создавать вторую.

Готово, когда: известен `workspaceId`, и либо известен `boardId`
существующей доски, либо её точно нет.

### Task 1: Каркас доски

**Produces:** `boardId`; ID каждого списка; ID каждой метки; ID каждого
Custom Field (или отметка «fallback»).

- [ ] **Step 1:** Создать доску `moneyAccounting` (если нет), удалить/
  архивировать дефолтные списки Trello («To Do / Doing / Done»), если они
  пустые.
- [ ] **Step 2:** Создать отсутствующие списки в порядке:
  `📥 Inbox`, `📋 Backlog`, `🧱 Tech debt`, `⏭️ Next`, `🔨 In progress`,
  `👀 Review / PR`, `✅ Done (unreleased)`, `📌 Docs & Decisions`.
  Списки `🚀 Released: …` создаются в Task 4–5, справа от Done.
- [ ] **Step 3:** Создать отсутствующие метки: `server` (blue), `front`
  (sky), `feature` (green), `bug` (red), `tech-debt` (orange), `chore`
  (gray / no color), `security` (black), `P1-urgent` (purple). Дефолтные
  безымянные метки Trello удалить.
- [ ] **Step 4:** Создать Custom Fields `Fix version server`,
  `Fix version front`, `Spec`, `PR` (тип text). Если коннектор/тариф не даёт
  — зафиксировать fallback (Review Focus 2).
- [ ] **Step 5 (проверка):** `trelloReadBoard` → сверить: 8 списков в этом
  порядке, 8 меток с этими цветами, 4 поля или отметка fallback; дублей нет.

### Task 2: Правила для Claude (`CLAUDE.md` + память)

**Files:**
- Create: `accounting_node/accounting/CLAUDE.md`
- Create: `accounting_react/CLAUDE.md`

**Consumes:** все ID из Task 1.

- [ ] **Step 1:** Написать раздел `## Trello` (одинаковый в обоих файлах):
  ссылка на доску, `boardId`; таблица «список → ID»; «метка → ID»;
  «поле → ID» или «fallback: метки sv/fv»; путь к спеке; формат ветки
  `<тип>/<idShort>-<slug>` (тип сервера `feat|fix|chore`, фронта
  `enh|fix|chore`), строка `Trello: #<idShort>` в PR; таблица событий и
  список «без согласия не делать» из раздела спеки «Автоматика Claude»;
  правило «Trello недоступен». Ссылки на списки — только по ID
  (Review Focus 5). Явно: ID для ветки — `idShort` (Review Focus 3).
- [ ] **Step 2:** Сохранить в память Claude проекта (`memory/`) короткую
  project-заметку: доска `moneyAccounting`, правила в `CLAUDE.md` обоих
  репозиториев, спека по пути выше; добавить строку в `MEMORY.md`.
- [ ] **Step 3:** Создать в `📌 Docs & Decisions` карточку «Правила доски»
  с той же краткой версией правил и ссылкой на спеку; закрепить её первой.
- [ ] **Step 4 (проверка):** `git status` в обоих репо — `CLAUDE.md` не
  появился как untracked (подтверждение, что он игнорируется); все ID в
  `CLAUDE.md` совпадают с `trelloReadBoard`.

### Task 3: Docs & Decisions

- [ ] **Step 1:** По карточке на каждую спеку из
  `accounting_node/accounting/docs/superpowers/specs/` (8 файлов, включая
  эту) и из `accounting_react/docs/superpowers/specs/` (если есть).
  Название — тема спеки; описание — путь к спеке и плану, 1–2 строки сути;
  метки компонента и `epic:<тема>` при необходимости.
- [ ] **Step 2:** Карточки для `docs/architecture-decision-ssr-vs-separate-apps.md`
  (ADR) и для деплой-доков (`deployment-linux-server.md`,
  `environment-variables.md`) — одна карточка «Деплой и окружение» с обоими
  путями.
- [ ] **Step 3 (проверка):** число карточек в списке = числу спек + 2
  (+ «Правила доски»); дублей нет.

### Task 4: Релиз server v0.1.0

- [ ] **Step 1:** `git fetch origin` и показать пользователю `origin/main`
  (хеш + сообщение) — подтвердить, что это задеплоенный squash v0.1.0
  (Review Focus 4). Без «да» — дальше не идти.
- [ ] **Step 2:** Тег: `git tag -a v0.1.0 <hash> -m "server v0.1.0"`;
  push тега `git push origin v0.1.0` — после согласия пользователя.
- [ ] **Step 3:** На ветке `chore/bump-version-0.1.0` от `dev`: `version` в
  `package.json` → `0.1.0` (и `package-lock.json` через
  `npm version 0.1.0 --no-git-tag-version`); коммит; PR в `dev` — после
  согласия пользователя на push/PR.
- [ ] **Step 4:** Собрать перечень PR релиза:
  все коммиты `git log --oneline v0.1.0`, в сообщении которых есть номер PR
  (`Merge pull request #NN` или squash-формат `(#NN)`), уникальные по номеру;
  разложить по типу по префиксу ветки (`feat` → Features, `fix` → Fixes,
  `chore` → Tech debt/Chore).
- [ ] **Step 5:** Список `🚀 Released: server v0.1.0` справа от Done;
  карточка-релиз `server v0.1.0 — <дата тега>` с release notes по разделам,
  ссылкой на тег, метки `server`, поле `Fix version server = 0.1.0`.
- [ ] **Step 6 (проверка):** `git ls-remote --tags origin v0.1.0` возвращает
  выбранный хеш; карточка на доске; перечень PR непустой и без дублей.

### Task 5: Релиз front v0.1.0

Шаги Task 4 для `accounting_react`, с отличиями:
- основная ветка — `origin/master`; перед тегом спросить пользователя,
  выкачен ли этот `master` (если нет — фронт остаётся без тега и релиза,
  список Released не создаётся, отметить это в ответе);
- тип веток фронта `enh` → Features;
- список `🚀 Released: front v0.1.0`, карточка-релиз с меткой `front`,
  поле `Fix version front = 0.1.0`.

### Task 6: Стартовый Backlog и Tech debt

- [ ] **Step 1:** Собрать кандидатов: `FIX_PROMPTS.md`, `PARSE_PHOTO_PROMPTS.md`
  (корень `moneyAccounting/accounting_node/`), `grep -rnE 'TODO|FIXME|HACK'`
  по `src/` обоих репо (без `node_modules`, `dist`), незакрытые пункты
  спек/планов (неотмеченные `- [ ]`, разделы «Open questions»/«Later»).
- [ ] **Step 2:** Показать пользователю таблицу: название, тип, компонент,
  список (Backlog / Tech debt / Inbox), источник. Ничего не создавать.
- [ ] **Step 3:** После согласия создать отобранные карточки по шаблону
  спеки (раздел «Карточка»), с источником в «Ссылки». Порядок в Backlog —
  как дал пользователь.
- [ ] **Step 4 (проверка):** число созданных карточек = числу одобренных.

### Task 7: Пробный прогон

- [ ] **Step 1:** Пользователь выбирает реальную задачу; провести её по
  правилам из `CLAUDE.md`: Next → ветка `<тип>/<idShort>-<slug>` →
  In progress → PR со строкой `Trello: #<idShort>` → Review / PR → merge →
  Done (unreleased).
- [ ] **Step 2 (проверка):** у карточки заполнены `Spec`/`PR`, в
  комментариях журнал всех переходов; GitHub Power-Up (если пользователь
  подключил) показывает PR на карточке.
- [ ] **Step 3:** Неудобства прогона — правки в спеку и `CLAUDE.md`.
