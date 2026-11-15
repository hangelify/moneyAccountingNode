# HAN-49 Source Filter and Manual Bill Edit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter the bill list by `source` and let `PUT /households/:hid/bills/:id` edit a manual bill (amount, category, sub-category, note) without leaving total ≠ sum of lines.

**Architecture:** `ListBillsQueryDto` gets `source[]`; `listBills` adds an `IN (...)` condition. `UpdateBillDto` gets three shortcut fields that address the bill's only line. The manual-only rules (shortcut checks, line edit, total sync) live in a new pure module `manual-bill-edit.ts`; `BillCrudService.updateBill` calls it, so the 1091-line service and its 60-line function limit do not grow.

**Tech Stack:** NestJS, MikroORM (PostgreSQL), class-validator, Jest (unit `*.spec.ts`, int `*.int-spec.ts` against a real DB).

**Spec:** `docs/superpowers/specs/2026-11-15-han-49-manual-bill-edit-design.md` (also Linear document «Spec: HAN-49 …»).

## Global Constraints

- Branch `feat/han-49-manual-bill-edit` (from dev @ 5887ec5). PR to `dev`, body `Fixes HAN-49`.
- Commit style: `feat(bill): … (HAN-49)`; end each commit with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Lint limits (no new suppressions): `max-lines` 300, `max-lines-per-function` 60, `max-params` 4, `sonarjs/cognitive-complexity` 15, `max-depth` 3, `no-nested-ternary`.
- No migration: `bills.source` and `bill_sub_categories.category_id` already exist.
- `PUT` behaviour for `source = photo | bank` must not change; shortcut fields on them → 400.
- Do NOT use `= ANY(?)` with an array param: knex expands it and Postgres fails (known bug HAN-102, `market_names`). Build one `?` per value: `b.source IN (?, ?, …)`.
- Error type for every new rejection: `BadRequestException` (400).
- Gate before PR: `npm run verify` (type-check, lint:check, arch, dup, knip, test). Int tests need local Postgres (`DB_*` env, defaults `localhost:5432 postgres/postgres accounting`).

## Review Focus

1. **Legacy "manual" bills.** The HAN-65 backfill marked every bill without an AI request as `manual`, and `POST /bills` creates multi-line `manual` bills. Editing only `description`/`bill_date` of such a bill with an existing mismatch must still succeed. The total check runs only when `total_amount` or `items` is sent. Test in Task 3.
2. **Existing `bill-update.int-spec.ts` bills default to `manual`** (entity default) and send `items` whose sum ≠ total. Make its `makeBill` create `source: photo` so those tests keep testing the photo path. Task 3, Step 1.
3. **`sub_category_id: null` without `category_id`** keeps the line's current category and only drops the sub-category. It must not leave the line uncategorized. Test in Task 3.
4. **`category_id` equal to the current category** keeps the sub-category and the AI confidence/reasoning. Only a real change resets them. Test in Task 3.
5. **Empty `?source=`**: the query string `source=` must be treated as absent (like `date_from=''`), not as 400. Test in Task 1.

---

### Task 1: `source` filter on the bill list

**Files:**
- Modify: `src/modules/bill/dto/list-bills-query.dto.ts` (new field after `currency`)
- Modify: `src/modules/bill/bill-crud.service.ts` (`listBills`, after the `currency` condition, ~line 247)
- Test: `src/modules/bill/dto/list-bills-query.dto.spec.ts`, `src/modules/bill/bill-source.int-spec.ts`

**Interfaces:**
- Produces: `ListBillsQueryDto.source?: BillSource[]`

- [ ] **Step 1: Failing DTO tests** in `list-bills-query.dto.spec.ts`:
  - `'accepts a single source and wraps it in an array'`: `toDto({ source: 'manual' })` → `dto.source` equals `[BillSource.MANUAL]`, no errors.
  - `'accepts several sources'`: `{ source: ['manual', 'bank'] }` → no errors.
  - `'rejects an unknown source'`: `{ source: ['cash'] }` → error on property `source`.
  - `'treats source="" as absent'`: `{ source: '' }` → `dto.source` undefined, no error on `source`.
- [ ] **Step 2: Failing int test** in `bill-source.int-spec.ts`, `'filters the list by source'`. Create one manual bill (`createBill`) and one photo draft confirmed via `confirmBill`. Or insert a confirmed bill with `source = 'photo'` through `sql(...)`. Then:
  - `listBills(householdId, { source: [BillSource.MANUAL] })` → every row `source === 'manual'`, the photo bill id absent.
  - `{ source: [BillSource.PHOTO] }` → contains the photo bill id, no manual rows.
  - `{ source: [BillSource.MANUAL, BillSource.PHOTO] }` → both ids present, and `meta.total` matches `data.length`.
- [ ] **Step 3: Run, expect FAIL**: `npm test -- list-bills-query.dto.spec bill-source.int-spec`
- [ ] **Step 4: Implement.** In the DTO, add `@ApiPropertyOptional({ enum: BillSource, isArray: true, … })` with the same `Transform` as `market_names` (wrap a string into an array, and map `''`/`['']` to undefined), `@IsOptional() @IsArray() @IsEnum(BillSource, { each: true })`. In `listBills`, when `filters.source?.length`, push `` `b.source IN (${filters.source.map(() => '?').join(', ')})` `` and `params.push(...filters.source)`.
- [ ] **Step 5: Run, expect PASS** (same command).
- [ ] **Step 6: Commit** `feat(bill): filter the bill list by source (HAN-49)`

---

### Task 2: Shortcut fields in `UpdateBillDto`

**Files:**
- Modify: `src/modules/bill/dto/update-bill.dto.ts`
- Create: `src/modules/bill/dto/update-bill.dto.spec.ts`

**Interfaces:**
- Produces on `UpdateBillDto`:
  - `category_id?: string` (`@IsUUID() @IsOptional()`)
  - `sub_category_id?: string | null` (`@ValidateIf(o => o.sub_category_id !== null) @IsUUID() @IsOptional()`; Swagger `nullable: true`)
  - `note?: string` (`@IsString() @Length(1, 255) @IsOptional()`, the same bounds as `ConfirmBillItemDto.raw_name`)
  - Swagger description on each: "Manual bill with one line only; edits that line. Not together with items."

- [ ] **Step 1: Failing tests** (`plainToInstance` + `validate`, as in `list-bills-query.dto.spec.ts`):
  - `'accepts category_id, sub_category_id and note'` with valid UUIDs and `note: 'coffee'` → no errors.
  - `'accepts sub_category_id null'` → no errors.
  - `'rejects a non-uuid category_id'` → error on `category_id`.
  - `'rejects an empty note'` (`''`) and `'rejects a note over 255 chars'` → error on `note`.
- [ ] **Step 2: Run, expect FAIL**: `npm test -- update-bill.dto.spec`
- [ ] **Step 3: Add the three fields.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(bill): shortcut line fields on bill update (HAN-49)`

---

### Task 3: Manual bill edit in `updateBill`

**Files:**
- Create: `src/modules/bill/manual-bill-edit.ts`
- Modify: `src/modules/bill/bill-crud.service.ts` (`updateBill`, ~lines 373–432)
- Modify: `src/modules/bill/bill-update.int-spec.ts` (`makeBill` only)
- Create: `src/modules/bill/manual-bill-edit.int-spec.ts` (same bootstrap as `bill-update.int-spec.ts`: `crud()` helper, one household, two categories `Food` / `Transport`, two subs under `Food`, one sub under `Transport`)

**Interfaces:**
- Consumes: `UpdateBillDto.category_id | sub_category_id | note` (Task 2); `LineCategories`, `assignLineCategory` (`bill-lines.ts`); `isAmountMismatch` (`bill-totals.ts`); `findLineCategories` (private, already in the service).
- Produces in `manual-bill-edit.ts`:
  - `hasLineShortcut(dto: UpdateBillDto): boolean`: true when any of the three fields is not `undefined`.
  - `checkLineShortcut(bill: Bill, lines: BillSubCategory[]): void`: 400 unless `bill.source === BillSource.MANUAL` and `lines.length === 1`.
  - `applyLineShortcut(line: BillSubCategory, dto: UpdateBillDto, found: LineCategories): void`
  - `syncManualTotal(bill: Bill, lines: BillSubCategory[], dto: UpdateBillDto, tolerance: number): void`: no-op unless `bill.source === BillSource.MANUAL`.

**Rules the code must follow (from the spec):**
- `updateBill`, before the transaction: `dto.items` together with any shortcut field → 400. If a shortcut is present, `found = await this.findLineCategories(householdId, [dto])`. That call already gives 400 for an unknown or foreign id and for a sub-category outside the given `category_id`.
- In the transaction, after loading `lines` (no `items` branch): if there is a shortcut, run `checkLineShortcut`, then `applyLineShortcut(lines[0], dto, found)`. Then always run `syncManualTotal(bill, lines, dto, this.itemTolerance)` before `em.flush()`.
- `applyLineShortcut`:
  - `sub_category_id` is a string → `assignLineCategory(line, subCat)`.
  - `sub_category_id === null` → no sub-category; category = `category_id`'s category if sent, else the line's current category.
  - Only `category_id` → keep the sub-category if `line.category?.id === category_id`, else drop it; category = the new one.
  - `note` → `raw_name`.
  - If the line's sub-category or category actually changed → `category_confidence = null` and `category_reasoning = null`.
- `syncManualTotal` (manual only):
  - no `items`, one line, `total_amount` sent → `line.amount = total_amount` and `line.price_per_unit = null`.
  - `items` sent, no `total_amount` → `bill.amount` = sum of line amounts, added in cents.
  - otherwise, `total_amount` or `items` sent and `isAmountMismatch(bill.amount, lines.map(l => l.amount), tolerance)` → 400.
  - neither sent → nothing (Review Focus 1).

- [ ] **Step 1: Keep the existing tests on the photo path.** In `bill-update.int-spec.ts` `makeBill`, add `source: BillSource.PHOTO` to the created bill. Run `npm test -- bill-update.int-spec`: expect PASS, as before.
- [ ] **Step 2: Failing int tests** in `manual-bill-edit.int-spec.ts`. The helper `makeManual(lines = 1)` creates a confirmed `manual` bill (amount 10) with `lines` lines under `Food`/sub-0: one line of 10, or two lines of 4 + 6.
  - `'moves total_amount into the only line'`: `{ total_amount: 7.5 }` → line amount 7.5, `price_per_unit` null, result `amount_mismatch === false`.
  - `'moves the line to another category and drops a sub-category of the old one'`: `{ category_id: transport }` → line `category` = Transport, `sub_category` null, confidence/reasoning null.
  - `'keeps the sub-category when category_id is the current one'`: `{ category_id: food }` → sub-0 kept, confidence unchanged (Review Focus 4).
  - `'sets the sub-category and its category from sub_category_id'`: `{ sub_category_id: transportSub }` → category Transport.
  - `'drops only the sub-category on sub_category_id null'`: → category still Food, sub null (Review Focus 3).
  - `'rejects a sub-category outside category_id'`: `{ category_id: transport, sub_category_id: foodSub1 }` → `BadRequestException`.
  - `'writes note into raw_name'`: `{ note: 'coffee' }` → `raw_name === 'coffee'`.
  - `'rejects shortcut fields together with items'`, `'rejects shortcut fields on a photo bill'`, `'rejects shortcut fields on a manual bill with two lines'` → `BadRequestException`, and the line is unchanged.
  - `'adds a line through items and recomputes the total'`: `items` = the existing line (10) + a new one (2.5), no `total_amount` → bill amount 12.5, `source` still `manual`.
  - `'rejects items that do not add up to total_amount'`: `items` 10 + 2.5, `total_amount: 20` → 400, bill unchanged.
  - `'rejects a total that no longer matches two lines'`: two lines, `{ total_amount: 11 }` → 400.
  - `'edits the date of a legacy manual bill with mismatched lines'`: a manual bill of amount 10 with lines 4 + 4, `{ bill_date: '2026-06-01' }` → succeeds (Review Focus 1).
- [ ] **Step 3: Run, expect FAIL**: `npm test -- manual-bill-edit.int-spec`
- [ ] **Step 4: Implement `manual-bill-edit.ts` and wire it into `updateBill`** per the rules above. If `updateBill` goes over 60 lines, move the shortcut pre-check, the `found` lookup or the line handling into a private method.
- [ ] **Step 5: Run, expect PASS**: `npm test -- manual-bill-edit.int-spec bill-update.int-spec bill-confirm.int-spec`
- [ ] **Step 6: Commit** `feat(bill): edit a manual bill without total/line mismatch (HAN-49)`

---

### Task 4: Verify and open the PR

- [ ] **Step 1:** `npm run verify`. Expect every stage to pass with no new lint suppressions (`git diff eslint-suppressions.json` is empty).
- [ ] **Step 2:** Push the branch and open a PR to `dev`. Body: summary, `Fixes HAN-49`, and a note that the front side is HAN-51.
- [ ] **Step 3:** In Linear, move HAN-49 to In Review (if the integration did not), add a comment with the PR link, and in HAN-51 add a comment with the new API contract (the `source` filter, the shortcut fields, the 400 cases).
