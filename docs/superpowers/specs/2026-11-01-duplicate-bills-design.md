# Duplicate bills — design

Date: 2026-11-01
Status: approved design, not implemented

## Goal

The same purchase can enter a household more than once: two members each
upload the receipt, one person uploads it again after confirming, or a bill
typed by hand is also uploaded as a photo. Today every copy is counted, so the
dashboard and spending breakdown overstate spending.

After this change the API **finds likely duplicates and shows them to the
user**, the user decides, and a bill marked as a duplicate stays in the
database but is **counted once** — through its original — everywhere money
is summed.

### Decisions taken

- **The user decides.** Nothing is marked automatically; the API only
  returns candidates. No endpoint blocks because of a possible duplicate.
- **A duplicate is a status, plus a link to its original** (`status =
  'duplicate'`, `duplicate_of_id`). Every aggregate query already filters
  `status = 'confirmed'`, so duplicates drop out of all of them without
  touching their SQL, and a query written later cannot forget the rule.
  Rejected: a link column alone (every query needs an extra filter) and a
  duplicate-groups table (more than "count once" needs).
- **Receipts are matched by what they print.** The AI parser also reads the
  fiscal register id, the receipt number and the purchase time. Matching on
  these is near-certain; date + amount + market is the fallback for bills
  without them (hand-entered, unreadable).
- `image_sha256` and its unique draft index stay as they are: they stop the
  same photo file from paying for a second AI call. This feature covers every
  other way a copy arrives.
- **Out of scope:** bank/CSV import. The finder takes a date tolerance so an
  import can reuse it later without a redesign.

## 1. Data model

### `bills`

- `bill_status_enum` gets the value `'duplicate'`.
- `duplicate_of_id uuid NULL` — self-FK to `bills(id)`, `ON DELETE NO
  ACTION`. Not `SET NULL`: a hard delete would leave a duplicate without an
  original and break the check below. Bills are only soft-deleted; §3.5
  handles that.
- Check constraint `bills_duplicate_of_check`:
  `(status = 'duplicate') = (duplicate_of_id IS NOT NULL)`.
- Partial index `bills_duplicate_of_id_index` on `(duplicate_of_id)
  WHERE duplicate_of_id IS NOT NULL`.
- Receipt identity, all nullable, filled from the parse and editable:
  - `fiscal_register_id varchar(64)` — cash register / fiscal device id;
  - `fiscal_receipt_number varchar(64)` — receipt (check) number;
  - `purchase_time time` — `HH:MM` from the receipt timestamp.
- Index `bills_household_fiscal_index` on `(household_id,
  fiscal_register_id, fiscal_receipt_number) WHERE deleted_at IS NULL AND
  fiscal_receipt_number IS NOT NULL`. **Not unique**: "keep both" must stay
  possible and the model can misread a number.

Invariant kept by the service (§3): `duplicate_of_id` always points to a
live, **confirmed** bill of the same household — never to a draft, a deleted
bill or another duplicate. There are no chains.

Migration note: PostgreSQL cannot use an enum value added by `ALTER TYPE
... ADD VALUE` in the same transaction. Add the value in its own migration,
then the columns, constraint and indexes in the next one. Regenerate the
MikroORM snapshot; `scripts/check-migrations.ts` must pass.

Entity: `Bill.duplicate_of?: Rel<Bill>` (`fieldName: 'duplicate_of_id'`),
`fiscal_register_id?`, `fiscal_receipt_number?`, `purchase_time?` (string,
`HH:MM`); `BillStatus.DUPLICATE = 'duplicate'`.

### `bill_duplicate_dismissals` (new)

A pair the user said is **not** a duplicate. Used only to filter
suggestions (§3.4).

| column | type |
| --- | --- |
| `id` | uuid PK |
| `household_id` | uuid FK → households, not null |
| `bill_id` | uuid FK → bills, not null — the smaller id of the pair |
| `other_bill_id` | uuid FK → bills, not null — the larger id |
| `dismissed_by_user_id` | uuid FK → users, null, `ON DELETE SET NULL` |
| `created_at` | timestamptz not null default now() |

Check `bill_id < other_bill_id`; unique index on `(bill_id, other_bill_id)`.
Storing each pair once in a fixed order makes a second dismissal a no-op.

## 2. Parsing

- `ParsedBillSchema` gets three fields, each `.nullable().catch(null)` like
  the other optional fields, bounded to the column sizes:
  - `fiscal_register_id: string` (trimmed, ≤ 64);
  - `fiscal_receipt_number: string` (trimmed, ≤ 64);
  - `purchase_time: string` matching `HH:MM` (24-hour).
- `BILL_PARSER_SYSTEM_PROMPT` and `BILL_PARSE_CATEGORIZE_SYSTEM_PROMPT` ask
  for them: copy the register / fiscal device id and the receipt number
  exactly as printed, the time from the receipt timestamp, and null when not
  confidently readable. The parse-and-categorize schema inherits the fields.
- `createDraftFromParsed` saves them on the draft.
- `CreateBillDto`, `ConfirmBillDto` and `UpdateBillDto` accept the three
  fields as optional, so a hand-entered bill can carry a receipt number and a
  misread one can be corrected.

## 3. Behaviour

### 3.1 Finding candidates — `BillDuplicatesService`

New file `src/modules/bill/bill-duplicates.service.ts`.

`findCandidates(householdId, probe, { excludeBillId?, dateToleranceDays = 0, limit = 5 })`

`probe` holds `amount`, `currency`, `bill_date`, `market_id`,
`market_name_raw`, `fiscal_register_id`, `fiscal_receipt_number`,
`purchase_time` — taken from a bill or a draft.

It returns live (`deleted_at IS NULL`), **confirmed** bills of the household,
excluding `excludeBillId`, each with a `match`:

1. `fiscal` — same `fiscal_register_id` and `fiscal_receipt_number` (both
   non-null on both bills);
2. `strong` — same currency, same amount, `bill_date` within the tolerance,
   **and** either the same market (equal `market_id`, or equal
   case-insensitive trimmed `COALESCE(markets.name, market_name_raw)`) or the
   same `purchase_time`;
3. `weak` — same currency, same amount, `bill_date` within the tolerance.

Bills with different non-null fiscal receipt numbers on the same register are
not candidates: they are two receipts. Results are ordered `fiscal`,
`strong`, `weak`, then closest date, then newest first. The ranking is a pure
function with its own unit test; the SQL only gathers rows that can match.

A candidate in a response (`PossibleDuplicateDto`):

```json
{
  "id": "…",
  "bill_date": "2026-10-03",
  "total_amount": 412.5,
  "currency": "MDL",
  "market_name": "Linella",
  "created_by_name": "Ana",
  "match": "fiscal"
}
```

### 3.2 Where candidates are shown

Never blocking; always `possible_duplicates: PossibleDuplicateDto[]`
(empty when none).

- `POST /bills/parse-photo` — the draft response, from the parsed fields.
  The user knows before reviewing the items.
- `GET /bills/:id`, which serves drafts and confirmed bills alike. For a
  duplicate it returns `duplicate_of: PossibleDuplicateDto` (its original,
  without `match`) and no candidates.
- `POST /bills` and `POST /bills/:id/confirm` — after the write, for a bill
  saved as confirmed.

`POST /bills` and `POST /bills/:id/confirm` accept an optional
`duplicate_of_id`. When set, the bill is saved directly as a duplicate of
that bill, under the same rules as §3.3 (in the same transaction as the
create/confirm). When unset, the bill is confirmed as today.

### 3.3 Marking and unmarking

`POST /bills/:id/mark-duplicate` — body `{ duplicate_of_id }`.

In one transaction, locking both rows `FOR UPDATE` in id order:

- the bill must be live and **confirmed** (a draft is marked through confirm;
  an already-duplicate bill is unmarked first) — else 409;
- the target must be live and in the same household — else 404;
- target = the bill itself → 400;
- if the target is a duplicate, the bill is linked to the target's original
  instead;
- bills that were duplicates **of this bill** are re-pointed to the new
  original, so there are no chains;
- `status = 'duplicate'`, `duplicate_of = original`.

Returns the bill detail (with `duplicate_of`).

`POST /bills/:id/unmark-duplicate` — the bill must be a duplicate (else
400); `status = 'confirmed'`, `duplicate_of = null`. Returns the bill detail.

### 3.4 Suggestions for bills already confirmed

`GET /bills/duplicate-suggestions?date_from&date_to` (both optional, ISO
dates, same validation as `GET /bills`).

Returns pairs of live confirmed bills of the household that match by §3.1,
excluding pairs in `bill_duplicate_dismissals`:

```json
{ "pairs": [ { "bill": { … }, "other": { … }, "match": "strong" } ] }
```

Ordered by match rank, then newest `bill_date`; at most 100 pairs. This is
how a household cleans up double-counting it already has.

`POST /bills/:id/dismiss-duplicate` — body `{ other_bill_id }`. Both bills
live and in the household (else 404), not the same bill (400). Inserts the
ordered pair with `ON CONFLICT DO NOTHING`; 204.

### 3.5 Deleting

- Deleting a duplicate: soft-delete as today.
- Deleting an original (`softDeleteBill`): in the same transaction, the
  oldest duplicate (`created_at`, then `id`) becomes `confirmed` with no
  link, and the other duplicates are re-pointed to it. The purchase stays
  counted exactly once.

### 3.6 Other paths

- `PUT /bills/:id` on a duplicate is allowed and keeps it a duplicate.
- `POST /bills/:id/confirm` on a duplicate keeps returning 409; the message
  says the bill is not a draft instead of "already confirmed".
- Draft cleanup and retention only touch drafts: unchanged.
- Two members confirming the same receipt at the same moment both end up
  confirmed; suggestions (§3.4) surface the pair. Accepted.

## 4. Reads and totals

- **No SQL change** in `bill-dashboard.service.ts`,
  `spending-breakdown.service.ts`, `household-conversion.ts` or the market
  bill counts in `market.service.ts`: they sum `status = 'confirmed'`, which
  excludes duplicates. The dashboard's recent-bills list hides them too.
- `GET /bills` gets `include_duplicates` (boolean, default `false`). When
  true, the filter is `status IN ('confirmed', 'duplicate')`. Every row gets
  `status` and `duplicate_of_id`, so the UI can grey duplicates out.

## 5. Testing

Test-first, following the existing unit / `int-spec` split.

Unit:

- candidate ranking: `fiscal` > `strong` > `weak`; different receipt numbers
  on the same register never match; `excludeBillId`; date tolerance;
- `ParsedBillSchema`: the new fields are kept when valid and become `null`
  when garbled (bad time, over-long id);
- prompts spec mentions the new fields.

Integration (real database):

- `mark-duplicate`: happy path; target is a duplicate → linked to its
  original; this bill's duplicates re-pointed; draft, self, deleted and
  other-household targets refused;
- `unmark-duplicate`;
- deleting an original promotes the oldest duplicate and re-points the rest;
- confirm and create with `duplicate_of_id`;
- `possible_duplicates` on parse-photo (stubbed AI), confirm and create;
- suggestions, with and without a dismissal; dismissing twice is a no-op;
- dashboard, spending breakdown, market counts and `GET /bills` totals
  count two copies of one receipt once when one is marked;
- the check constraint rejects a duplicate without an original.

Migration: `scripts/check-migrations.ts` passes with the regenerated
snapshot.

## 6. Docs

`docs/frontend-duplicate-bills-integration.md`, in the style of the other
frontend integration docs: the `possible_duplicates` field, the mark, unmark,
dismiss and suggestions endpoints, `include_duplicates`, and the suggested UI
("Ana already added this on Oct 3 — mark as duplicate / keep both").
