# Email verification hard gate — design

## Goal
A user who has not confirmed their email address cannot use the application.
This replaces the soft gate of P31
(`2026-10-12-email-verification-mfa-design.md`), where only household invites
required a verified address.

## Decisions (agreed with user)
- Login and register keep issuing tokens to unverified users. Every
  authenticated endpoint refuses them with 403, except the few they need to
  finish verification or leave (see "Open to unverified users").
- Existing unverified users are gated too: their address was never proven
  (see the P31 migration). They verify through `resend-verification`.
- The check lives in `JwtAuthGuard`, closed by default. A route opts out with
  `@AllowUnverified()`. A new controller that uses `JwtAuthGuard` is gated
  without extra code.

Rejected:
- A separate `EmailVerifiedGuard` per controller: forgetting it on a new
  controller silently opens it.
- A global `APP_GUARD`: global guards run before controller guards, so
  `req.user` is not set yet.
- A check in `JwtStrategy.validate`: it would answer 401, and clients treat
  401 as an expired token (refresh / logout loop).

## Open to unverified users
Marked `@AllowUnverified()`, all in `AuthController`:
- `GET /auth/me` — the client reads `email_verified` to pick the screen.
- `POST /auth/resend-verification` — the only way to get a new link.
- `POST /auth/logout`, `POST /auth/logout-all`.
- `GET /auth/sessions`, `DELETE /auth/sessions/:id` — ending sessions is a
  security action, not access to data.

Not affected (no `JwtAuthGuard`): `register`, `login`, `refresh`, `revoke`,
`verify-email`.

Gated: everything else, including `POST /auth/change-password`, bills, bill
batches, budgets, categories, sub-categories, markets, households and planning
horizons.

## Refusal
```json
{ "statusCode": 403, "error": "email_not_verified", "message": "Email address is not verified" }
```
`AllExceptionsFilter` passes an object response through unchanged, so clients
branch on `error === 'email_not_verified'`. No `WWW-Authenticate` header: the
token is valid.

Order in the guard: authentication first, unchanged (401 with the Bearer
challenge). The verification check runs only for an authenticated user, so an
unauthenticated request never learns whether an account is verified.

## Components
- `src/modules/auth/decorators/allow-unverified.decorator.ts` —
  `ALLOW_UNVERIFIED_KEY` and `AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED_KEY, true)`.
- `JwtAuthGuard` — injects `Reflector`. In `handleRequest`, after a user is
  accepted: if `reflector.getAllAndOverride(ALLOW_UNVERIFIED_KEY, [handler, class])`
  is not true and `user.email_verified_at` is null, throw
  `ForbiddenException` with the body above. `JwtStrategy` already selects
  `email_verified_at`, so no extra query.
- `AuthController` — `@AllowUnverified()` on the six routes above;
  `@ApiResponse({ status: 403 })` on `change-password`.
- `HouseholdService.assertEmailVerified` stays as defence in depth for invites.

Swagger on the other controllers is not changed per method; the 403 is
documented in the frontend doc.

## Tests (TDD)
- `jwt-auth.guard.spec.ts`: unverified user → 403 `email_not_verified`;
  verified user passes; unverified user passes when the handler or the class
  carries `@AllowUnverified()`; no token still → 401 with bare challenge;
  bad token still → 401 `invalid_token`.
- `auth.controller.spec.ts`: exactly the six handlers carry the metadata.
- E2E `test/auth-email-verification.e2e-spec.ts`: an unverified user gets 403
  `email_not_verified` on a gated route (e.g. `GET /households`) and 200 on
  `GET /auth/me`; after verifying, the gated route answers 200.
- `test/utils/app.ts` `registerUser` already verifies by default. With
  `verified: false` it must stop calling `GET /households` (now 403) and read
  the personal household id from the database instead. Specs that use
  unverified users on gated routes (household invites) are updated to expect
  403 from the guard.

## Docs
- P31 spec: note that the soft gate is replaced, with a link here.
- New `docs/frontend-email-verification-gate.md`: on `email_not_verified`,
  show the "confirm your email" screen with a resend button; check
  `GET /auth/me` → `email_verified` after login.

## Out of scope
- A grace period after registration.
- Public resend by email.
- MFA.
