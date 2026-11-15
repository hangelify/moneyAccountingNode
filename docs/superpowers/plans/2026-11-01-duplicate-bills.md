# Duplicate Bills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find likely duplicate bills, let the user mark one as a duplicate of another, and count each purchase once in every total.

**Architecture:** A new `duplicate` bill status plus a `duplicate_of_id` self-link. Every aggregate query already sums `status = 'confirmed'`, so duplicates drop out without SQL changes. A new `BillDuplicatesService` finds candidates (matched on parsed fiscal ids, then on amount, date and market), and handles marking, unmarking, promotion on delete, suggestions and dismissals.

**Tech Stack:** NestJS 11, MikroORM 7 (PostgreSQL 16, raw SQL via `conn.execute`), zod (AI schemas), class-validator DTOs, Jest (`*.spec.ts` unit; `*.int-spec.ts` / `*.e2e-spec.ts` against a real DB).

**Spec:** `docs/superpowers/specs/2026-11-01-duplicate-bills-design.md`

**Branch:** `feat/duplicate-bills` off `dev`. `docs/` is gitignored, so commits carry code only.

## Global Constraints

- Status value `'duplicate'`; column `duplicate_of_id uuid NULL`, FK to `bills(id)` `ON DELETE NO ACTION`.
- Check `bills_duplicate_of_check`: `(status = 'duplicate') = (duplicate_of_id IS NOT NULL)`.
- `duplicate_of_id` always points to a live, confirmed bill of the same household: no chains, no drafts, no deleted bills.
- `fiscal_register_id varchar(64)`, `fiscal_receipt_number varchar(64)`, `purchase_time time` (`HH:MM`), all nullable.
- Match ranks, in order: `fiscal` > `strong` > `weak`. Candidates are capped at 5, suggestions at 100 pairs.
- No endpoint ever blocks or refuses a write because of a possible duplicate.
- Aggregate SQL in `bill-dashboard.service.ts`, `spending-breakdown.service.ts`, `household-conversion.ts` and `market.service.ts` is **not** edited.
- Enum value added in its own migration; columns, constraint and indexes in the next one.
- Unit tests: `npm run test -- <path>`. Integration tests: `npm run test:e2e -- <path>` (needs the test DB from `test/setup`).

## Review Focus

1. **Mark cycle:** A is a duplicate of B, then the user marks B as a duplicate of A. The target resolves to its original, which is B itself, so the API answers 400 and never creates a loop. Test in Task 5.
2. **Decimal amounts:** a stored `10.50` and a probe of `10.5` are the same amount. Ranking compares numbers, not strings. Test in Task 3.
3. **Market spelling:** `"LINELLA "` and `"Linella"` are the same market for `strong`. Test in Task 3.
4. **Null currency:** two hand-entered bills without a currency, with the same amount and date, still match (`IS NOT DISTINCT FROM`). Test in Task 3.
5. **Deleted duplicate:** deleting an original never promotes an already-deleted duplicate. Test in Task 6.

---

### Task 1: Schema, entities and migrations

**Files:**
- Create: `src/migrations/Migration20261101120000_AddDuplicateBillStatus.ts`
- Create: `src/migrations/Migration20261101120001_AddBillDuplicates.ts`
- Create: `src/entities/bill-duplicate-dismissal.entity.ts`
- Modify: `src/types/bill-status.enum.ts`, `src/entities/bill.entity.ts`, `src/migrations/.snapshot-accounting.json`, `src/modules/bill/bill.module.ts` (`forFeature` adds `BillDuplicateDismissal`)
- Test: `src/modules/bill/bill-duplicates-schema.int-spec.ts`

**Interfaces:**
- Produces: `BillStatus.DUPLICATE = 'duplicate'`. On `Bill`: `duplicate_of?: Rel<Bill> | null` (`fieldName: 'duplicate_of_id'`), `fiscal_register_id?: string`, `fiscal_receipt_number?: string`, `purchase_time?: string` (`HH:MM`; map `time` with `runtimeType: 'string'`). Entity `BillDuplicateDismissal` with `household`, `bill`, `other_bill`, `dismissed_by?`, `created_at`.

- [ ] **Step 1: Write the failing int-spec.** Seed a household, a user and two confirmed bills using the seeding style of `bill-queries.int-spec.ts`. Tests:
  - `rejects a duplicate without an original`: a raw `update bills set status = 'duplicate' where id = ?` rejects with a check violation.
  - `rejects an original on a non-duplicate`: setting `duplicate_of_id` on a confirmed bill rejects.
  - `saves a duplicate with its original`: `status = 'duplicate', duplicate_of_id = <other>` succeeds.
  - `stores a dismissal pair once, smaller id first`: inserting `(larger, smaller)` violates `bill_duplicate_dismissals_order_check`, and a second identical insert violates the unique index.
  - `round-trips purchase_time as HH:MM`: save `'14:05'`, then reading back gives `'14:05'`.
- [ ] **Step 2: Run it and confirm it fails.** `npm run test:e2e -- src/modules/bill/bill-duplicates-schema.int-spec.ts`. Expected: FAIL (invalid enum value / column does not exist).
- [ ] **Step 3: Write migration 1.** `up`: `alter type "bill_status_enum" add value if not exists 'duplicate';`. `down`: a comment noting that Postgres cannot drop an enum value, and the down is a no-op.
- [ ] **Step 4: Write migration 2,** in the style of `Migration20261012120000_AddBillConfirmedBy`:
  - The columns from Global Constraints.
  - FK `bills_duplicate_of_id_foreign` (`on update cascade on delete no action`).
  - Check `bills_duplicate_of_check`.
  - Partial index `bills_duplicate_of_id_index` (`where duplicate_of_id is not null`).
  - Partial index `bills_household_fiscal_index` from spec §1.
  - Table `bill_duplicate_dismissals` per spec §1: check `bill_duplicate_dismissals_order_check` (`bill_id < other_bill_id`) and unique index `bill_duplicate_dismissals_pair_unique` on `(bill_id, other_bill_id)`. Every FK is indexed, following the comment in `Migration20261010130000`: index `other_bill_id`, `household_id` and `dismissed_by_user_id`.
  - `down` drops all of it in reverse order.
- [ ] **Step 5: Update entities and the enum.** Mirror the new indexes on `Bill` with `@Index({ name, expression })`, as the existing ones are declared. Then run `npm run migration:fresh && npm run migration:check`. Expected: no pending changes; regenerate the snapshot until it reports none.
- [ ] **Step 6: Run the int-spec and confirm it passes.** Same command as step 2. Expected: PASS.
- [ ] **Step 7: Commit.** `git commit -m "feat(bill): add duplicate status, receipt identity and dismissals schema"`

### Task 2: Parse and store receipt identity

**Files:**
- Modify: `src/modules/bill/tasks/schemas/parsed-bill.schema.ts`, `src/modules/bill/tasks/prompts.ts`, `src/modules/bill/dto/parsed-bill-response.dto.ts`, `src/modules/bill/dto/create-bill.dto.ts`, `src/modules/bill/dto/confirm-bill.dto.ts`, `src/modules/bill/dto/update-bill.dto.ts`, `src/modules/bill/dto/bill-detail-response.dto.ts`, `src/modules/bill/bill-crud.service.ts` (`createDraftFromParsed`, `findDraftByImageHash`, `createBill`, `confirmBill`, `updateBill`, `toDetailDto`)
- Test: `src/modules/bill/tasks/schemas/parsed-bill.schema.spec.ts`, `src/modules/bill/tasks/prompts.spec.ts`, `src/modules/bill/dto/bill-items.dto.spec.ts` (or a new `receipt-identity.dto.spec.ts`), `src/modules/bill/bill-draft-from-ai.int-spec.ts`

**Interfaces:**
- Consumes: the Task 1 `Bill` columns.
- Produces:
  - `ParsedBill` and `ParsedBillResponseDto` gain `fiscal_register_id: string | null`, `fiscal_receipt_number: string | null`, `purchase_time: string | null`.
  - A shared export from `parsed-bill.schema.ts`: `MAX_FISCAL_ID_LENGTH = 64`, `PURCHASE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/`.
  - `CreateBillDto`, `ConfirmBillDto` and `UpdateBillDto` gain the same three optional fields: `@IsString() @Length(1, 64)`, and `@Matches(PURCHASE_TIME_PATTERN)` for the time.
  - `BillDetailResponseDto` exposes them.

- [ ] **Step 1: Write the failing schema tests.**
  - `keeps receipt identity when valid`: input `{ fiscal_register_id: ' J403001234 ', fiscal_receipt_number: '0042', purchase_time: '14:05' }` parses to `'J403001234'`, `'0042'`, `'14:05'`.
  - `nulls garbled receipt identity`: `purchase_time: '25:99'`, a 65-char `fiscal_register_id` and a numeric `fiscal_receipt_number: 42` all become `null`, and the rest of the bill still parses.
  - In `prompts.spec.ts`: both prompts contain `fiscal_register_id`, `fiscal_receipt_number` and `purchase_time`.
- [ ] **Step 2: Run them and confirm they fail.** `npm run test -- src/modules/bill/tasks`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Schema fields use `.nullable().catch(null)`. An over-long id becomes `null` rather than being truncated, because a cut-off id would produce false fiscal matches.
  - Add the prompt lines from spec §2 to both prompts, under "Extract:".
- [ ] **Step 4: Run them and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Write the failing DTO and int tests.**
  - DTO spec: `ConfirmBillDto` rejects `purchase_time: '9:5'` and accepts `'09:05'`.
  - `bill-draft-from-ai.int-spec.ts`: `saves receipt identity on the draft and returns it on re-upload`. `createDraftFromParsed` saves the three fields, and `findDraftByImageHash` returns them.
  - `bill-confirm.int-spec.ts`: `confirm overrides receipt identity`.
- [ ] **Step 6: Run them and confirm they fail.** Then implement the DTO fields and the service wiring: draft save, re-upload shape, create, confirm and update apply the fields when given, and `toDetailDto` returns them.
- [ ] **Step 7: Run unit and int tests and confirm they pass.** `npm run test -- src/modules/bill && npm run test:e2e -- src/modules/bill/bill-draft-from-ai.int-spec.ts src/modules/bill/bill-confirm.int-spec.ts`. Expected: PASS.
- [ ] **Step 8: Commit.** `git commit -m "feat(bill): parse and store fiscal receipt identity"`

### Task 3: Candidate finder

**Files:**
- Create: `src/modules/bill/bill-duplicates.ts` (pure ranking), `src/modules/bill/bill-duplicates.service.ts`, `src/modules/bill/dto/bill-duplicates.dto.ts`
- Modify: `src/modules/bill/bill.module.ts` (provide `BillDuplicatesService`)
- Test: `src/modules/bill/bill-duplicates.spec.ts`, `src/modules/bill/bill-duplicates.int-spec.ts`

**Interfaces:**
- Produces:
  - `type DuplicateMatch = 'fiscal' | 'strong' | 'weak'`.
  - `interface DuplicateProbe { amount: number; currency: Currency | null; bill_date: string; market_id: string | null; market_name: string | null; fiscal_register_id: string | null; fiscal_receipt_number: string | null; purchase_time: string | null }`. Here `market_name` is `COALESCE(markets.name, market_name_raw)`.
  - `interface CandidateRow extends DuplicateProbe { id: string; created_at: string; created_by_name: string | null }`.
  - `function rankCandidates(probe: DuplicateProbe, rows: CandidateRow[], opts: { dateToleranceDays: number; limit: number }): Array<{ row: CandidateRow; match: DuplicateMatch }>`
  - `class PossibleDuplicateDto { id; bill_date; total_amount: number; currency: Currency | null; market_name: string | null; created_by_name: string | null; match?: DuplicateMatch }`
  - `BillDuplicatesService.findCandidates(householdId: string, probe: DuplicateProbe, opts?: { excludeBillId?: string; dateToleranceDays?: number; limit?: number }): Promise<PossibleDuplicateDto[]>`, with defaults `dateToleranceDays = 0`, `limit = 5`.
  - `BillDuplicatesService.probeOf(bill: Bill): DuplicateProbe`, for callers that hold an entity.

- [ ] **Step 1: Write the failing ranking unit tests** in `bill-duplicates.spec.ts`:
  - `ranks fiscal over strong over weak`: three rows, one per rank; the result order is `['fiscal', 'strong', 'weak']`.
  - `never matches different receipt numbers on the same register`: the row has the same amount, date and market but `fiscal_receipt_number` `'0043'` vs `'0042'` on the same register. Result is `[]`.
  - `matches 10.50 and 10.5`: probe `amount: 10.5`, row `amount: Number('10.50')`, so the result is `weak`. (Review Focus 2)
  - `treats market names case- and space-insensitively`: `'LINELLA '` vs `'Linella'` gives `strong`. (Review Focus 3)
  - `strong on the same purchase_time without a market`: both markets are null and both times are `'14:05'`, so the result is `strong`.
  - `matches two bills without a currency`: both `currency: null`, so the result is `weak`. (Review Focus 4)
  - `respects date tolerance`: a date one day off gives `[]` at tolerance 0 and `weak` at tolerance 1.
  - `orders ties by closest date, then newest created_at` and `caps at limit`.
- [ ] **Step 2: Run them and confirm they fail.** `npm run test -- src/modules/bill/bill-duplicates.spec.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `rankCandidates`.** A row is a candidate if it matches `fiscal` (both ids non-null and equal on both sides), or if its amounts are equal (compare cents: `Math.round(x * 100)`), its currencies are equal (null equals null) and its dates are within tolerance. Exclude a row when both sides have the same non-null `fiscal_register_id` but different non-null receipt numbers.
- [ ] **Step 4: Run them and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Write the failing int-spec** in `bill-duplicates.int-spec.ts`:
  - `finds a confirmed bill by fiscal ids across different amounts` (the AI misread a total; fiscal still matches).
  - `ignores drafts, duplicates, deleted bills, other households and excludeBillId`.
  - `returns created_by_name and market_name` (market name from `markets.name`, falling back to `market_name_raw`).
- [ ] **Step 6: Run it and confirm it fails.** `npm run test:e2e -- src/modules/bill/bill-duplicates.int-spec.ts`.
- [ ] **Step 7: Implement `findCandidates`.** One `conn.execute` selects rows that could match: same household, `status = 'confirmed'`, `deleted_at IS NULL`, `id <> excludeBillId`, and either `(fiscal_register_id, fiscal_receipt_number) = (?, ?)` or (`amount = ?`, `currency IS NOT DISTINCT FROM ?`, `bill_date BETWEEN ?::date - ? AND ?::date + ?`). Join `markets` and `users` for the names (`users.first_name`), then hand the rows to `rankCandidates`.
- [ ] **Step 8: Run it and confirm it passes.** Same command. Expected: PASS.
- [ ] **Step 9: Commit.** `git commit -m "feat(bill): find likely duplicate bills"`

### Task 4: Show candidates on parse, read, create and confirm

**Files:**
- Modify: `src/modules/bill/bill.controller.ts` (`parsePhoto`), `src/modules/bill/bill-crud.service.ts` (`getBill`, `createBill`, `confirmBill`), `src/modules/bill/dto/parsed-bill-response.dto.ts` (`ParsePhotoResponseDto`), `src/modules/bill/dto/bill-detail-response.dto.ts`, `src/modules/bill/dto/api-responses.decorator.ts`
- Test: `src/modules/bill/bill-duplicates.int-spec.ts`, `src/modules/bill/bill.controller.spec.ts`

**Interfaces:**
- Consumes: `BillDuplicatesService.findCandidates` and `probeOf` from Task 3.
- Produces:
  - `ParsePhotoResponseDto.possible_duplicates: PossibleDuplicateDto[]`.
  - `BillDetailResponseDto.possible_duplicates: PossibleDuplicateDto[]` and `duplicate_of: PossibleDuplicateDto | null` (an original without `match`).
  - `BillDuplicatesService.originalOf(householdId: string, duplicateOfId: string): Promise<PossibleDuplicateDto>`.

- [ ] **Step 1: Write the failing tests.**
  - Controller spec: `parse-photo returns possible_duplicates for the saved draft`, using a mocked `BillDuplicatesService` that returns one candidate. Also, a re-uploaded photo (the `duplicate: true` path) still carries `possible_duplicates`.
  - Int-spec:
    - `getBill of a draft lists confirmed look-alikes`.
    - `getBill of a duplicate returns duplicate_of and no candidates`.
    - `createBill returns possible_duplicates and still saves the bill as confirmed`.
    - `confirmBill returns possible_duplicates excluding itself`.
- [ ] **Step 2: Run them and confirm they fail.** `npm run test -- src/modules/bill/bill.controller.spec.ts && npm run test:e2e -- src/modules/bill/bill-duplicates.int-spec.ts`.
- [ ] **Step 3: Implement.**
  - Inject `BillDuplicatesService` into `BillCrudService` and `BillController`.
  - Candidates are computed after the write commits, never inside the confirm transaction.
  - For parse-photo, build the probe from the saved draft response with `market_id: null`.
  - Document the new fields in the Swagger decorators.
- [ ] **Step 4: Run them and confirm they pass,** together with existing bill unit tests: `npm run test -- src/modules/bill`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(bill): return possible duplicates on parse, read, create and confirm"`

### Task 5: Mark, unmark, and `duplicate_of_id` on create and confirm

**Files:**
- Modify: `src/modules/bill/bill-duplicates.service.ts`, `src/modules/bill/bill-crud.service.ts` (`createBill`, `confirmBill`, the confirm 409 message), `src/modules/bill/bill.controller.ts`, `src/modules/bill/dto/create-bill.dto.ts`, `src/modules/bill/dto/confirm-bill.dto.ts`, `src/modules/bill/dto/bill-duplicates.dto.ts`, `src/modules/bill/dto/api-responses.decorator.ts`, `src/modules/bill/bill-crud.service.spec.ts`, `src/modules/bill/bill-confirm.int-spec.ts`
- Test: `src/modules/bill/bill-duplicates.int-spec.ts`

**Interfaces:**
- Consumes: `originalOf` from Task 4.
- Produces:
  - `BillDuplicatesService.linkAsDuplicate(em: EntityManager, bill: Bill, duplicateOfId: string, householdId: string): Promise<void>`. It runs inside the caller's transaction and applies spec §3.3: lock rows in id order, resolve a duplicate target to its original, 400 for self, 404 for a missing target, re-point this bill's duplicates, then set status and link.
  - `markDuplicate(id: string, householdId: string, duplicateOfId: string): Promise<BillDetailResponseDto>`: 409 unless the bill is confirmed.
  - `unmarkDuplicate(id: string, householdId: string): Promise<BillDetailResponseDto>`: 400 unless the bill is a duplicate.
  - `MarkDuplicateDto { duplicate_of_id: string }` (`@IsUUID()`).
  - Optional `duplicate_of_id` (`@IsUUID() @IsOptional()`) on `CreateBillDto` and `ConfirmBillDto`.
  - Routes `POST /bills/:id/mark-duplicate` (200) and `POST /bills/:id/unmark-duplicate` (200), each with `ParseUUIDPipe` like the other `:id` routes.

- [ ] **Step 1: Write the failing int-spec:**
  - `marks a confirmed bill as a duplicate`: status is `duplicate`, and the dashboard total for the month counts one copy.
  - `links to the original when the target is itself a duplicate`.
  - `re-points this bill's duplicates to the new original`: C is a duplicate of B, then B is marked as a duplicate of A, so C now points at A.
  - `refuses a cycle`: A is a duplicate of B, then B is marked as a duplicate of A, giving 400 and leaving both unchanged. (Review Focus 1)
  - `refuses self (400), a draft bill (409), a deleted or other-household target (404)`.
  - `unmark returns the bill to confirmed`, and `unmark of a confirmed bill is 400`.
  - `confirm with duplicate_of_id saves a duplicate`, and `create with duplicate_of_id saves a duplicate`.
  - `confirm with a bad duplicate_of_id rolls back`: the bill stays a draft, and its items are unchanged.
  - `editing a duplicate keeps it a duplicate`: `PUT /bills/:id` changing the description leaves `status` and `duplicate_of_id` as they were (spec §3.6).
- [ ] **Step 2: Run it and confirm it fails.** `npm run test:e2e -- src/modules/bill/bill-duplicates.int-spec.ts`.
- [ ] **Step 3: Implement `linkAsDuplicate`, `markDuplicate` and `unmarkDuplicate`.** Wire `duplicate_of_id` into `createBill` (wrap its flush in `em.transactional`) and into `confirmBill`, before the status is set to confirmed. Add the routes.
- [ ] **Step 4: Change the confirm 409 message** for a non-draft to `Bill with ID ${id} is not a draft`. Update the matching assertions in `bill-crud.service.spec.ts`, `bill-confirm.int-spec.ts` and the decorator description.
- [ ] **Step 5: Run unit and int tests and confirm they pass.** `npm run test -- src/modules/bill && npm run test:e2e -- src/modules/bill`. Expected: PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(bill): mark and unmark duplicate bills"`

### Task 6: Promote a duplicate when its original is deleted

**Files:**
- Modify: `src/modules/bill/bill-crud.service.ts` (`softDeleteBill`), `src/modules/bill/bill-duplicates.service.ts`
- Test: `src/modules/bill/bill-duplicates.int-spec.ts`

**Interfaces:**
- Produces: `BillDuplicatesService.promoteAfterDelete(em: EntityManager, originalId: string): Promise<void>`, called inside `softDeleteBill`'s transaction.

- [ ] **Step 1: Write the failing tests:**
  - `deleting an original promotes the oldest duplicate and re-points the rest`: A has duplicates B (older) and C. Deleting A makes B confirmed with no link, and C now points at B. The month total is unchanged.
  - `never promotes a deleted duplicate`: B (older) is already soft-deleted, so deleting A promotes C. (Review Focus 5)
  - `deleting a duplicate leaves its original alone`.
- [ ] **Step 2: Run them and confirm they fail.** `npm run test:e2e -- src/modules/bill/bill-duplicates.int-spec.ts`.
- [ ] **Step 3: Implement.** `softDeleteBill` runs in `em.transactional` and locks the bill. If it is an original, it calls `promoteAfterDelete`, which picks the live duplicate ordered by `created_at, id`. A deleted duplicate keeps its link; that row is soft-deleted, so the invariant only governs live bills.
- [ ] **Step 4: Run them and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(bill): promote a duplicate when its original is deleted"`

### Task 7: Suggestions and dismissals

**Files:**
- Modify: `src/modules/bill/bill-duplicates.service.ts`, `src/modules/bill/bill.controller.ts`, `src/modules/bill/dto/bill-duplicates.dto.ts`, `src/modules/bill/dto/api-responses.decorator.ts`
- Test: `src/modules/bill/bill-duplicates.int-spec.ts`, `src/modules/bill/dto/bill-duplicates.dto.spec.ts`

**Interfaces:**
- Consumes: `rankCandidates` from Task 3; the `BillDuplicateDismissal` entity from Task 1.
- Produces:
  - `DuplicateSuggestionsQueryDto { date_from?: string; date_to?: string }`, with the same validators as `ListBillsQueryDto`'s date fields.
  - `DuplicateSuggestionsResponseDto { pairs: Array<{ bill: PossibleDuplicateDto; other: PossibleDuplicateDto; match: DuplicateMatch }> }`.
  - `DismissDuplicateDto { other_bill_id: string }`.
  - `BillDuplicatesService.suggestions(householdId, query): Promise<DuplicateSuggestionsResponseDto>` and `dismiss(id, householdId, userId, otherBillId): Promise<void>`.
  - Routes: `GET /bills/duplicate-suggestions`, declared **before** `GET /bills/:id`; and `POST /bills/:id/dismiss-duplicate`, which returns 204.

- [ ] **Step 1: Write the failing tests:**
  - `lists each matching pair once, ranked, newest first`.
  - `respects date_from/date_to`, and `date_from > date_to is 400`.
  - `hides a dismissed pair whichever bill it was dismissed from`.
  - `dismissing twice is a no-op`.
  - `dismiss refuses self (400) and unknown or other-household bills (404)`.
  - `caps at 100 pairs`.
- [ ] **Step 2: Run them and confirm they fail.** `npm run test:e2e -- src/modules/bill/bill-duplicates.int-spec.ts`.
- [ ] **Step 3: Implement.** One SQL self-join over live confirmed bills in the range, pairing `a.id < b.id` on the fiscal key or on amount, currency and date. `LEFT JOIN` the dismissals on the ordered pair, and keep rows where the dismissal is null. Rank each pair with `rankCandidates`, then sort and cap. `dismiss` inserts `(least, greatest)` with `on conflict do nothing`.
- [ ] **Step 4: Run them and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(bill): suggest and dismiss duplicate pairs"`

### Task 8: Bill list flag, totals and frontend doc

**Files:**
- Modify: `src/modules/bill/dto/list-bills-query.dto.ts`, `src/modules/bill/dto/bill-list-response.dto.ts` / `bill-response.dto.ts` (row `status`, `duplicate_of_id`), `src/modules/bill/bill-crud.service.ts` (`listBills`)
- Create: `docs/frontend-duplicate-bills-integration.md` (gitignored; not committed)
- Test: `src/modules/bill/dto/list-bills-query.dto.spec.ts`, `src/modules/bill/bill-duplicates.int-spec.ts`

**Interfaces:**
- Produces: `ListBillsQueryDto.include_duplicates?: boolean`, with `@Transform` mapping `'true'` to `true` and `'false'` to `false` (anything else is left as is and fails `@IsBoolean()`), and `@IsOptional()`. Default `false`. Each list row includes `status: BillStatus` and `duplicate_of_id: string | null`.

- [ ] **Step 1: Write the failing tests:**
  - DTO spec: `include_duplicates parses 'true' and rejects 'yes'`.
  - Int-spec, with two copies of one receipt and one marked as a duplicate:
    - The dashboard `by_currency` and `in_household_currency` totals, the spending breakdown, and the market `bill_count` (`market.service.ts`) each count one copy.
    - `GET /bills` hides the duplicate by default.
    - With `include_duplicates=true`, the list returns both, with the duplicate's `status` and `duplicate_of_id`.
- [ ] **Step 2: Run them and confirm they fail.** `npm run test -- src/modules/bill/dto && npm run test:e2e -- src/modules/bill/bill-duplicates.int-spec.ts`. Expected: the list tests fail. The total tests already pass, which is the point: they lock the rule in.
- [ ] **Step 3: Implement.** With the flag set, `listBills` uses `b.status IN ('confirmed','duplicate')`. Select `b.status` and `b.duplicate_of_id` in the list query and map them.
- [ ] **Step 4: Run the full verification.** `npm run lint:check && npm run type-check && npm run test && npm run test:e2e && npm run migration:check`. Expected: all pass.
- [ ] **Step 5: Write `docs/frontend-duplicate-bills-integration.md`** in the format of `docs/frontend-confirm-bill-integration.md`. Cover `possible_duplicates`, `duplicate_of`, `duplicate_of_id` on create and confirm, the mark, unmark, dismiss and suggestions endpoints, `include_duplicates`, and the suggested "already added by Ana on Oct 3 — mark as duplicate / keep both" UI.
- [ ] **Step 6: Commit the code.** `git commit -m "feat(bill): list duplicates on request"`
