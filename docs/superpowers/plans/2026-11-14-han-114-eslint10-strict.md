# HAN-114: ESLint 10 + strictTypeChecked — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести сервер на ESLint 10 со строгими наборами правил, все правила в `error`, старые нарушения — в `eslint-suppressions.json`.

**Architecture:** Один flat-конфиг `eslint.config.mjs` (`defineConfig`), отдельный блок для тестов. Механические нарушения чинятся `--fix`, остальное замораживается встроенными bulk suppressions ESLint. CI не меняется — меняется скрипт `lint:check`.

**Tech Stack:** ESLint 10, typescript-eslint 8.72, `@eslint-community/eslint-plugin-eslint-comments`, prettier, Jest.

**Spec:** `docs/superpowers/specs/2026-11-14-han-114-eslint10-strict-design.md`

**Ветка:** `chore/han-114-eslint10-strict` (уже создана от `dev` `c631ac2`).

## Global Constraints

- `eslint` ^10, `@eslint/js` ^10, `typescript-eslint` ^8.72, `globals` ^17; `@eslint/eslintrc` удалён.
- В конфиге нет ни одного правила в `warn`; глобальных `off` для правил из списка ниже нет.
- Явно `error`: `no-floating-promises`, `no-misused-promises`, `no-unsafe-argument`, `no-explicit-any`, `switch-exhaustiveness-check`, `explicit-function-return-type`, `no-console`, `no-warning-comments` (`terms: ['todo','fixme']`), `eslint-comments/require-description`, `eslint-comments/no-unused-disable`.
- Поведение кода не меняется: после каждой задачи с правками кода — `npm run type-check`, `npm run test`, `npm run test:e2e` зелёные.
- Коммиты заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **lint-staged на файле из baseline.** Коммит, который правит старый файл и не добавляет нарушений, должен проходить; коммит, добавляющий нарушение, — падать. Проверка — Task 4, шаг 5.
2. **Файлы `scripts/*.ts`.** lint-staged линтит любой `*.ts`, а `lint:check` — только `{src,apps,libs,test}`. Без baseline для `scripts/` первая же правка там валит pre-commit. Решение (моё): добавить `scripts` в глоб всех lint-скриптов — Task 1, Task 4.
3. **Автофикс и prettier.** `no-confusing-void-expression` превращает `() => f()` в `() => { f(); }` — формат должен совпасть с prettier, иначе `prettier --check` в lint-staged упадёт. Проверка — Task 2, шаг 3.
4. **Исправленное нарушение без prune.** ESLint 10 падает на неиспользуемых подавлениях; сообщение должно вести к `npm run lint:prune`. Проверка — Task 4, шаг 6.
5. **`dot-notation` против будущего `noPropertyAccessFromIndexSignature` (HAN-115).** Автофикс `obj['x']` → `obj.x` на типах с index signature потом сломается в HAN-115. Решение: `dot-notation` с `allowIndexSignaturePropertyAccess: false` по умолчанию оставить, но в Task 2 проверить 3 исправленных места — если тип с index signature, вернуть скобки и отметить в PR.

---

### Task 1: Зависимости и новый конфиг

**Files:**
- Modify: `package.json`, `package-lock.json`, `eslint.config.mjs`

**Interfaces:**
- Produces: конфиг с блоками `ignores` → `recommended` → `strictTypeChecked` → `stylisticTypeChecked` → `languageOptions` → правила кода → блок тестов → prettier последним. Глоб линта: `"{src,apps,libs,test,scripts}/**/*.ts"`.

- [ ] **Step 1:** `npm i -D eslint@^10 @eslint/js@^10 typescript-eslint@^8.72 globals@^17 @eslint-community/eslint-plugin-eslint-comments@^4.8 eslint-plugin-prettier@latest` и `npm rm @eslint/eslintrc`. Ожидается: `npm ls eslint` — одна версия 10.x, без `invalid`/`ERESOLVE`.
- [ ] **Step 2:** Переписать `eslint.config.mjs`:
  - `defineConfig` из `eslint/config`; `ignores: ['eslint.config.mjs', 'dist/**']`.
  - `languageOptions` как сейчас (globals node+jest, `sourceType: 'commonjs'`, `projectService`).
  - `linterOptions.reportUnusedDisableDirectives: 'error'`.
  - Правила кода: список из Global Constraints; `no-extraneous-class: ['error', { allowWithDecorator: true }]`; `prettier/prettier: ['error', { endOfLine: 'auto' }]`. Плагин eslint-comments подключить через его flat-конфиг `recommended` + два правила выше.
  - Блок тестов, `files: ['**/*.spec.ts', '**/*.int-spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts']`: `explicit-function-return-type: ['error', { allowExpressions: true, allowTypedFunctionExpressions: true }]`, `unbound-method: 'off'`.
- [ ] **Step 3:** Проверить, что в конфиге нет `'warn'`: `grep -n "warn" eslint.config.mjs` — пусто.
- [ ] **Step 4:** `npx eslint "{src,apps,libs,test,scripts}/**/*.ts" -f json -o /tmp/…/lint.json` (scratchpad) и посчитать нарушения по правилам. Ожидается: конфиг загружается без ошибок; `no-extraneous-class` = 0; `explicit-function-return-type` в тестах заметно меньше 373. Цифры записать для описания PR.
- [ ] **Step 5:** Commit `chore(lint): upgrade to ESLint 10 with strict type-checked rules` (lint:check пока красный — это ожидаемо внутри ветки).

### Task 2: Автофикс механических правил

**Files:**
- Modify: файлы `src/**`, `test/**`, `scripts/**`, которые затронет `--fix`.

**Interfaces:**
- Consumes: конфиг Task 1.

- [ ] **Step 1:** Применить фиксы только выбранных правил. CLI `--fix` не фильтрует по правилам, поэтому — разовый скрипт на Node API в scratchpad (не коммитится): `new ESLint({ fix: (msg) => FIX_RULES.has(msg.ruleId) })`, `lintFiles(glob)`, `ESLint.outputFixes(results)`. `FIX_RULES` = `array-type`, `consistent-type-definitions`, `no-confusing-void-expression`, `dot-notation`, `no-inferrable-types`, `non-nullable-type-assertion-style`, `prefer-optional-chain` (все с префиксом `@typescript-eslint/`).
- [ ] **Step 2:** `npx prettier --write "{src,test,scripts}/**/*.ts"`, затем `git diff --stat` — меняются только файлы с фиксами.
- [ ] **Step 3:** `npx prettier --check "{src,test,scripts}/**/*.ts"` — зелёный (Review Focus 3).
- [ ] **Step 4:** Просмотреть 3 правки `dot-notation` (Review Focus 5) и все `consistent-type-definitions` (`type` → `interface` меняет слияние деклараций — убедиться, что нет одноимённых деклараций).
- [ ] **Step 5:** `npm run type-check && npm run test && npm run test:e2e` — всё зелёное.
- [ ] **Step 6:** Повторить подсчёт Task 1 Step 4: по семи правилам — 0 (кроме тех, что `--fix` не берёт; остаток записать).
- [ ] **Step 7:** Commit `style(lint): apply mechanical autofixes for strict rules`.

### Task 3: Разбор 27 `eslint-disable`

**Files:**
- Modify: `src/modules/ai-gateway/providers/{deepseek,anthropic,openai}.provider.spec.ts`, `src/modules/ai-gateway/ai-gateway.service.int-spec.ts`, `src/modules/ai-gateway/internal/retry.ts`, `src/modules/bill/bill-crud.service.ts`, `src/modules/bill/bill-crud.service.spec.ts`, `src/modules/{budget,market,household,planing-horizon}/*.service.spec.ts`, `src/modules/category/category.controller.spec.ts`, `src/modules/household/guards/household-member.guard.spec.ts`, `src/modules/auth/{auth.module,auth.service}.spec.ts`, `test/setup/global-setup.ts`

- [ ] **Step 1:** Удалить `/* eslint-disable @typescript-eslint/unbound-method */` в 7 spec-файлах (правило выключено в блоке тестов). В `planing-horizon.service.spec.ts` оставить только `no-unsafe-assignment`, если он ещё нужен.
- [ ] **Step 2:** Для каждого оставшегося disable попробовать починить типами (типизированный мок вместо `any`, `as unknown as T`, `Error` в `reject`). Если починка требует переписать тест/логику — оставить disable с `-- <причина>` по-русски, одной фразой (например, `-- SDK отдаёт ответ без типов`).
- [ ] **Step 3:** `npx eslint` по затронутым файлам: нет `eslint-comments/require-description` и `no-unused-disable`.
- [ ] **Step 4:** `npm run type-check && npm run test && npm run test:e2e` — зелёные.
- [ ] **Step 5:** Commit `chore(lint): justify or remove eslint-disable directives`.

### Task 4: Baseline, скрипты, проверка храповика

**Files:**
- Create: `eslint-suppressions.json`
- Modify: `package.json` (scripts, lint-staged)

- [ ] **Step 1:** Скрипты в `package.json`:
  - `lint`: `eslint "{src,apps,libs,test,scripts}/**/*.ts" --fix`
  - `lint:check`: `eslint "{src,apps,libs,test,scripts}/**/*.ts" --max-warnings 0 --report-unused-disable-directives`
  - `lint:prune`: `eslint "{src,apps,libs,test,scripts}/**/*.ts" --prune-suppressions`
  - lint-staged не меняется (`prettier --check`, `eslint --fix`).
- [ ] **Step 2:** `npx eslint "{src,apps,libs,test,scripts}/**/*.ts" --suppress-all` → создан `eslint-suppressions.json` в корне.
- [ ] **Step 3:** `npm run lint:check` — exit 0, `0 problems`.
- [ ] **Step 4 (храповик):** добавить во временный файл `src/modules/health/health.service.ts` (или любой сервис) строку с вызовом async-метода без `await`; `npm run lint:check` — падает с `@typescript-eslint/no-floating-promises`. Откатить правку.
- [ ] **Step 5 (Review Focus 1):** в файле из baseline поправить комментарий, `git add` и `npx lint-staged` — проходит; добавить туда же `const x: any = 1;` — падает. Откатить.
- [ ] **Step 6 (Review Focus 4):** исправить одно замороженное нарушение, `npm run lint:check` — падает с сообщением о неиспользуемом подавлении; `npm run lint:prune` — счётчик в `eslint-suppressions.json` уменьшился, `lint:check` зелёный. Откатить обе правки.
- [ ] **Step 7:** `grep -n "lint:check" .github/workflows/ci.yml` — шаг на месте, менять нечего.
- [ ] **Step 8:** Commit `chore(lint): freeze existing violations in eslint-suppressions.json`.

### Task 5: Финальная проверка и PR

- [ ] **Step 1:** `npm run lint:check && npm run type-check && npm run build && npm run test && npm run test:e2e` — всё зелёное.
- [ ] **Step 2:** В описании PR: итоговые цифры (сколько нарушений исправлено автофиксом, сколько в baseline по правилам), список оставшихся `eslint-disable` с причинами, `Fixes HAN-114`.
