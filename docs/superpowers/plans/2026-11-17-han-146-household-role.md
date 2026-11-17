# HAN-146 Caller Role in Household Responses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every household response carries `role: 'owner' | 'member'` — the caller's role in that household.

**Architecture:** One field on `HouseholdResponseDto` (inherited by the list item and the detail DTO). `toDto` takes the role as a required argument so no response can omit it; the list SQL selects `m.role` from the caller's membership row it already joins.

**Tech Stack:** NestJS, MikroORM (Postgres), @nestjs/swagger, Jest (unit + e2e with supertest).

**Spec:** `docs/superpowers/specs/2026-11-17-han-146-household-role-design.md`

## Global Constraints

- Values are exactly `'owner'` and `'member'`; Swagger: `enum: ['owner', 'member']`, description `"The caller's role in this household"`.
- `GET /households` stays one SQL query.
- Field is additive only; no change to guards, permissions or membership model.
- Branch `feat/han-146-household-role`; commit messages `feat(households): … (HAN-146)` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A user who owns one household and is a member of another: the list must show the role **per row**, not one role for all rows (e2e in Task 2).
- `PUT /households/:hid/me` by a member returns `'member'`, not the owner's role from another membership (e2e in Task 2).
- `GET /households/:hid` returns the **caller's** role, not the first member's (e2e in Task 2, owner and member each asking).
- `toResponse` when the caller's membership is gone (removed between guard and response): `ForbiddenException`, never a guessed role (unit in Task 1).
- Existing unit tests mock `memberRepo.find` → `[]`; with the required role they must now include the caller's membership (Task 1, Step 1).

---

### Task 1: Role in DTO and service

**Files:**
- Modify: `src/modules/household/dto/household-response.dto.ts` (`HouseholdResponseDto`)
- Modify: `src/modules/household/household.service.ts` (`createHousehold`, `listHouseholds`, `getHousehold`, `toResponse`, `toDto`)
- Test: `src/modules/household/household.service.spec.ts`

**Interfaces:**
- Produces: `HouseholdResponseDto.role: 'owner' | 'member'`; `private toDto(h: Household, memberCount: number, role: 'owner' | 'member', displayName?: string | null): HouseholdResponseDto`.

- [ ] **Step 1: Update and add unit tests**

In `createHousehold` › `'creates household + owner membership and returns DTO'` add `expect(result.role).toBe('owner');`.

In `updateHousehold` tests, mock the caller's membership instead of `[]`:
`(memberRepo.find as jest.Mock).mockResolvedValue([{ user: { id: userId }, role: 'member', display_name: null }]);`
and in `'updates the name and returns DTO'` add `expect(result.role).toBe('member');`.

New test in `describe('updateHousehold')`:

```ts
it("refuses when the caller's membership is gone", async () => {
  const { service, memberRepo, em } = makeService();
  (em.findOne as jest.Mock).mockResolvedValue({ id: hid, name: 'X', created_at: new Date(), deleted_at: null });
  (memberRepo.find as jest.Mock).mockResolvedValue([{ user: { id: 'someone-else' }, role: 'owner', display_name: null }]);
  await expect(service.updateHousehold(hid, userId, { name: 'Y' })).rejects.toBeInstanceOf(ForbiddenException);
});
```

- [ ] **Step 2: Run, expect failures**

Run: `npm test -- src/modules/household/household.service.spec.ts`
Expected: FAIL — `result.role` is `undefined`; the new test resolves instead of rejecting.

- [ ] **Step 3: Implement**

- DTO: `@ApiProperty({ enum: ['owner', 'member'], description: "The caller's role in this household" }) role!: 'owner' | 'member';` on `HouseholdResponseDto`, after `member_count`.
- `toDto(h, memberCount, role, displayName?)` sets `role`.
- `createHousehold` → `this.toDto(household, 1, 'owner')`.
- `toResponse`: if `mine` is undefined → `throw new ForbiddenException()`; else `this.toDto(household, members.length, mine.role, mine.display_name)`.
- `getHousehold`: same `mine` lookup; missing → `ForbiddenException`; pass `mine.role`.
- `listHouseholds`: add `m.role,` to the select list (after `h.currency`).

- [ ] **Step 4: Run, expect pass; type-check**

Run: `npm test -- src/modules/household` then `npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/modules/household
git commit -m "feat(households): caller role in every household response (HAN-146)"
```

### Task 2: e2e coverage

**Files:**
- Test: `test/household-lifecycle.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1's `role` field; existing helpers `registerUser`, `createHousehold`, `listHouseholds`, `join` in this file.

- [ ] **Step 1: Add a `describe('caller role', …)` block**

```ts
it('lists the role per household', async () => {
  const owner = await registerUser(app, 'role-owner');
  const member = await registerUser(app, 'role-member');
  expect((await join(owner, owner.householdId, member)).status).toBe(204);
  const roles = (u: TestUser) => listHouseholds(u).then((l) => new Map(l.map((h) => [h.id, h.role])));
  expect((await roles(owner)).get(owner.householdId)).toBe('owner');
  const m = await roles(member);
  expect(m.get(owner.householdId)).toBe('member');
  expect(m.get(member.householdId)).toBe('owner');
});

it('returns the caller role from create, card, PUT and PUT me', async () => {
  // owner + member as above
  expect((await createHousehold(owner, { name: 'Trip' })).role).toBe('owner');
  // GET /households/:hid  → owner: 'owner', member: 'member'
  // PUT /households/:hid {name:'Renamed'} by owner → 200, role 'owner'
  // PUT /households/:hid/me {display_name:'Дом'} by member → 200, role 'member'
});
```

- [ ] **Step 2: Run**

Run: `npm run test:e2e -- test/household-lifecycle.e2e-spec.ts`
Expected: PASS (whole file, including existing tests).

- [ ] **Step 3: Swagger check**

Start the app (`npm run start:dev`), open `/api-json` (Swagger is mounted at `api` in `src/app.setup.ts`) and confirm `HouseholdResponseDto.properties.role` has `enum: [owner, member]` and the description; `HouseholdListItemDto` and `HouseholdDetailResponseDto` inherit it.

- [ ] **Step 4: Full check and commit**

Run: `npm run lint && npm test && npm run test:e2e`
Expected: all green.

```bash
git add test/household-lifecycle.e2e-spec.ts
git commit -m "test(households): e2e for the caller role (HAN-146)"
```
