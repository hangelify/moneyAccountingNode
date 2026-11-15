# Email Verification Hard Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users with an unconfirmed email get 403 `email_not_verified` on every authenticated endpoint except the few they need to verify or leave.

**Architecture:** `JwtAuthGuard.handleRequest` checks `user.email_verified_at` after authentication succeeds, unless the handler or class carries `@AllowUnverified()` metadata (read via `Reflector`). Closed by default; six `AuthController` routes opt out.

**Tech Stack:** NestJS 11, `@nestjs/passport`, Jest (unit + e2e with supertest, Postgres).

**Spec:** `docs/superpowers/specs/2026-11-03-email-verification-hard-gate-design.md`

## Global Constraints

- Refusal body, exactly: `{ statusCode: 403, error: 'email_not_verified', message: 'Email address is not verified' }`, no `WWW-Authenticate` header.
- Authentication runs first; 401 behaviour (bare / `invalid_token` challenge) is unchanged.
- Open routes (`@AllowUnverified()`): `GET /auth/me`, `POST /auth/resend-verification`, `POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`. Nothing else.
- `HouseholdService.assertEmailVerified` stays.
- Work on branch `feat/email-verification-hard-gate` (from `dev`). `docs/` is gitignored: doc edits are not committed.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A token issued while unverified works on gated routes right after `verify-email`, without re-login (the strategy reloads the user each request) — e2e in Task 3.
2. `POST /auth/refresh` still works for an unverified user, so the client keeps a session while waiting for the email — e2e in Task 3.
3. A request with no / bad token to a gated route is 401, never 403 (no leak of verification state) — unit in Task 1.
4. `@AllowUnverified()` on a class opens all its handlers — unit in Task 1.
5. A unit spec that builds `JwtAuthGuard` with `new` (controller specs use `overrideGuard`) must still compile: the constructor now takes a `Reflector` — run the full unit suite in Task 1.

---

### Task 1: `@AllowUnverified()` and the gate in `JwtAuthGuard`

**Files:**
- Create: `src/modules/auth/decorators/allow-unverified.decorator.ts`
- Modify: `src/modules/auth/guards/jwt-auth.guard.ts`
- Test: `src/modules/auth/guards/jwt-auth.guard.spec.ts`

**Interfaces:**
- Produces: `export const ALLOW_UNVERIFIED_KEY = 'allowUnverified'`; `export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED_KEY, true)`.
- Produces: `JwtAuthGuard` constructor `(private readonly reflector: Reflector)`; `handleRequest` signature unchanged.

- [ ] **Step 1: Update the spec's test context and write failing tests**

`contextWith(authorization?, { handler, cls } = {})` now also returns `getHandler: () => handler ?? function handler() {}` and `getClass: () => cls ?? class C {}`. The guard is `new JwtAuthGuard(new Reflector())`. Existing tests use `user = { id: 'u1', email_verified_at: new Date() }`.

New tests:
- `refuses an unverified user with 403 email_not_verified`: `user = { id: 'u2', email_verified_at: null }`; thrown error is `ForbiddenException`, `getStatus() === 403`, `getResponse()` equals the Global Constraints body exactly.
- `lets an unverified user through a handler marked @AllowUnverified()`: handler is a function decorated by applying `AllowUnverified()(target, key, descriptor)` — simplest: `class C { @AllowUnverified() h() {} }`, pass `C.prototype.h` and `C`; returns the user.
- `lets an unverified user through a class marked @AllowUnverified()`: `@AllowUnverified() class C { h() {} }`; returns the user.
- Existing 401 tests stay as they are; they pin Review Focus 3 (no user → 401, never 403).

- [ ] **Step 2: Run** `npx jest src/modules/auth/guards/jwt-auth.guard.spec.ts` — Expected: FAIL (decorator module not found / 403 tests fail).

- [ ] **Step 3: Implement** the decorator file and the check. In `handleRequest`, when `user && !err`: if `!this.reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED_KEY, [context.getHandler(), context.getClass()])` and `!(user as { email_verified_at?: Date | null }).email_verified_at`, throw `new ForbiddenException({ statusCode: 403, error: 'email_not_verified', message: 'Email address is not verified' })`. Short comment: closed by default, routes opt out with `@AllowUnverified()`. Keep `TUser` generic.

- [ ] **Step 4: Run** `npx jest src/modules/auth/guards/jwt-auth.guard.spec.ts` — PASS; then `npm test` and `npm run type-check` — PASS (Review Focus 5).

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/decorators/allow-unverified.decorator.ts src/modules/auth/guards/jwt-auth.guard.ts src/modules/auth/guards/jwt-auth.guard.spec.ts
git commit -m "feat(auth): refuse unverified users in JwtAuthGuard unless the route opts out"
```

### Task 2: Open the six `AuthController` routes

**Files:**
- Modify: `src/modules/auth/auth.controller.ts`
- Test: `src/modules/auth/auth.controller.spec.ts`

**Interfaces:**
- Consumes: `AllowUnverified`, `ALLOW_UNVERIFIED_KEY` from Task 1.

- [ ] **Step 1: Write the failing test** `describe('AuthController – @AllowUnverified metadata')`:

```ts
const open = ['getProfile', 'resendVerification', 'logout', 'logoutAll', 'listSessions', 'revokeSession'];
const marked = Object.getOwnPropertyNames(AuthController.prototype).filter(
  (name) => Reflect.getMetadata(ALLOW_UNVERIFIED_KEY, AuthController.prototype[name]) === true,
);
expect(marked.sort()).toEqual([...open].sort());
expect(Reflect.getMetadata(ALLOW_UNVERIFIED_KEY, AuthController)).toBeUndefined();
```

- [ ] **Step 2: Run** `npx jest src/modules/auth/auth.controller.spec.ts` — FAIL (`marked` is empty).

- [ ] **Step 3: Implement** `@AllowUnverified()` on those six methods; on `changePassword` add `@ApiResponse({ status: 403, description: 'Email address is not verified' })`.

- [ ] **Step 4: Run** `npx jest src/modules/auth/auth.controller.spec.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/auth.controller.ts src/modules/auth/auth.controller.spec.ts
git commit -m "feat(auth): keep profile, resend, logout and sessions open to unverified users"
```

### Task 3: End-to-end behaviour, test helpers and docs

**Files:**
- Modify: `test/utils/app.ts` (`registerUser`)
- Modify: `test/auth-email-verification.e2e-spec.ts`
- Modify: `test/auth-registration.e2e-spec.ts:50-55`
- Modify (not committed): `docs/superpowers/specs/2026-10-12-email-verification-mfa-design.md`
- Create (not committed): `docs/frontend-email-verification-gate.md`

**Interfaces:**
- Consumes: the gate from Tasks 1–2.

- [ ] **Step 1: Write failing e2e tests** in `auth-email-verification.e2e-spec.ts`, new `describe('access gate')`:
  - `refuses gated routes to an unverified user`: `GET /households` → 403, body `error === 'email_not_verified'`.
  - `keeps profile, resend and sessions open`: `GET /auth/me` → 200, `GET /auth/sessions` → 200.
  - `opens gated routes right after verification, with the same token`: verify via `verificationTokenFor`, then `GET /households` with the original access token → 200 (Review Focus 1).
  - `still refreshes the session of an unverified user`: `POST /auth/refresh` with `X-Client-Type: mobile` and `{ refresh_token }` → 200 (Review Focus 2).
  - In the existing invite test, also assert `error === 'email_not_verified'` on the 403 (now from the guard).

- [ ] **Step 2: Run** `npm run test:e2e -- auth-email-verification` — Expected: FAIL. `registerUser(…, { verified: false })` itself fails first (its `GET /households` now answers 403).

- [ ] **Step 3: Fix `registerUser`**: read the personal household id from the database instead of `GET /households` for both cases (one code path), e.g. `select h.id from households h join household_members m … where m.user_id = (select id from users where email = ?)` — match the real table/column names in `src/entities`. Update the doc comment.

- [ ] **Step 4: Update `auth-registration.e2e-spec.ts`**: the new user is unverified, so `GET /households` → 403 `email_not_verified`; replace the comment with "A new user must verify the email before using the app."

- [ ] **Step 5: Run** `npm run test:e2e` — Expected: all suites PASS.

- [ ] **Step 6: Docs**: in the P31 spec, under "Decisions", note the soft gate is replaced by `2026-11-03-email-verification-hard-gate-design.md`. Write `docs/frontend-email-verification-gate.md` in the style of the other `docs/frontend-*.md`: the 403 body, the open routes list, flow (after login read `GET /auth/me` → `email_verified`; on `email_not_verified` show the confirm-email screen with resend; `resend-verification` 429 cooldown and 503).

- [ ] **Step 7: Lint and commit**

```bash
npm run lint:check && npm run type-check
git add test/utils/app.ts test/auth-email-verification.e2e-spec.ts test/auth-registration.e2e-spec.ts
git commit -m "test(auth): cover the email verification gate end to end"
```
