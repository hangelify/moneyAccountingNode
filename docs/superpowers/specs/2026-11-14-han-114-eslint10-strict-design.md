# HAN-114: ESLint 10 + strictTypeChecked, всё в error, baseline

Задача: [HAN-114](https://linear.app/hangelify/issue/HAN-114) · Эпик: [HAN-113](https://linear.app/hangelify/issue/HAN-113)

## Зачем

Линтер — первый слой «жёстких проверок» эпика HAN-113: новый код (человека или агента) не должен
проходить с потерянным `await`, `any` и т.п. Сейчас важные правила в `warn` и их игнорируют.
ESLint 9 не поддерживается с 2026-08-06. На этом PR строятся HAN-121 (`verify`, CI) и HAN-118 (смеллы).

## Цели / не цели

- **Цели:** ESLint 10; `strictTypeChecked` + `stylisticTypeChecked`; ни одного правила в `warn`;
  старые нарушения заморожены в `eslint-suppressions.json`; новое нарушение валит `lint:check`.
- **Не цели:** чинить логические нарушения старого кода (`no-non-null-assertion`, `no-unnecessary-condition`,
  `restrict-template-expressions` и т.д.) — они уходят в baseline и вычищаются отдельными задачами.
- **Анти-цель:** изменение поведения кода. Автофиксы — только механические, проверяем тестами и `tsc`.

## Исходное состояние (dev `c631ac2`)

Пробный прогон строгого конфига: ~1050 нарушений в 224 из 455 файлов. Крупные:
`explicit-function-return-type` 503 (373 — тесты), `restrict-template-expressions` 107,
`prefer-nullish-coalescing` 80, `no-non-null-assertion` 74, `no-unnecessary-condition` 53,
`array-type` 50, `no-confusing-void-expression` 48, `no-extraneous-class` 17 (Nest-модули).
Автоисправимо 115. 27 `eslint-disable`, ни одного с пояснением.

## Подходы

- **А. Только заморозка** — минимальный diff, baseline больше.
- **Б. Заморозка + автофикс механических правил** — baseline меньше на ~115, diff шире.
- **Выбран Б** (владелец): открытых PR с фичами нет, риск конфликтов низкий.

## Решения

1. **Зависимости:** `eslint` ^10, `@eslint/js` ^10, `typescript-eslint` ^8.72, `globals` ^17,
   `@eslint-community/eslint-plugin-eslint-comments` (новая). Удалить `@eslint/eslintrc`.
   Конфиг — через `defineConfig` из `eslint/config` (вместо устаревшего `tseslint.config`).
2. **Наборы:** `eslint.configs.recommended`, `tseslint.configs.strictTypeChecked`,
   `tseslint.configs.stylisticTypeChecked`, prettier — последним.
3. **Явно в `error`:** `no-floating-promises`, `no-misused-promises`, `no-unsafe-argument`, `no-explicit-any`,
   `switch-exhaustiveness-check`, `explicit-function-return-type`, `no-console`,
   `no-warning-comments` (`todo`, `fixme`), `eslint-comments/require-description`,
   `eslint-comments/no-unused-disable`. В конфиге не остаётся ни одного `warn` / `off` глобально.
4. **Ложные срабатывания убираем конфигом, не baseline:**
   - `no-extraneous-class`: `allowWithDecorator: true` (Nest `@Module()`).
   - Тесты (`**/*.spec.ts`, `**/*.int-spec.ts`, `test/**`): отдельный блок —
     `explicit-function-return-type` с `allowExpressions: true` (колбэки `describe`/`it`),
     `unbound-method` → `off` только в этом блоке (`expect(mock.method)` — штатный приём jest;
     `eslint-plugin-jest` ради одного правила не тянем).
     Прочие правила — те же, что в коде.
   - `no-unnecessary-condition` на DTO с class-validator — точечно (`-- причина`), не глобально.
5. **Автофикс** (`eslint --fix` только этими правилами): `array-type`, `consistent-type-definitions`,
   `no-confusing-void-expression`, `dot-notation`, `no-inferrable-types`,
   `non-nullable-type-assertion-style`, `prefer-optional-chain`. Отдельным коммитом, после — `tsc`, unit- и e2e-тесты.
6. **27 `eslint-disable`:** где можно — починить; остальные — с `-- причина`.
7. **Baseline:** `eslint --suppress-all` → `eslint-suppressions.json` в корне, коммитится.
8. **Скрипты:** `lint:check` = `eslint ... --max-warnings 0 --report-unused-disable-directives`
   (ESLint 10 сам падает на устаревших подавлениях; `--prune-suppressions` — для чистки).
   `lint` с `--fix` остаётся. Добавить `lint:prune` = `eslint ... --prune-suppressions`.
   lint-staged: `eslint --fix` учитывает suppressions автоматически (файл в корне).
9. **CI:** шаг уже вызывает `npm run lint:check` — меняется только скрипт.

## Критерии готовности

- `npm run lint:check` зелёный, warnings = 0; `tsc`, unit- и e2e-тесты зелёные.
- `eslint-suppressions.json` закоммичен; новый floating promise в любом файле валит линт (проверить руками).
- Ни одного правила в `warn` в конфиге.

## Оставлено исполнителю

Точный набор опций правил, если ESLint 10 / typescript-eslint потребуют иного синтаксиса;
формулировки `-- причина` у оставшихся `eslint-disable`.
