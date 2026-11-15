# Email verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users confirm their email via a one-time link; household invites (create and accept) require a verified address.

**Architecture:** Three nullable columns on `users` hold the verification state and a SHA-256 hash of the single active token. A small `mail` module exposes a `MailSender` behind the `MAIL_SENDER` token (SMTP via nodemailer). `EmailVerificationService` in the auth module issues, sends, verifies and resends tokens; `HouseholdService` enforces the soft gate.

**Tech Stack:** NestJS 11, MikroORM 6 / PostgreSQL 16, nodemailer, Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-10-12-email-verification-mfa-design.md` (Iteration 1 only; MFA is not part of this plan).

## Global Constraints
- Only the SHA-256 hex of the token is stored; raw token = `randomBytes(32).toString('hex')`.
- TTL `EMAIL_VERIFICATION_TTL_HOURS`, default 24. Resend cooldown 60 s → `429`.
- Link: `${FRONTEND_URL}/verify-email?token=<raw>`.
- `POST /auth/verify-email` public, throttle 10 / 60 s, `204`; bad token → `400 Invalid or expired verification token`.
- `POST /auth/resend-verification` under `JwtAuthGuard`, throttle 3 / 60 s, `204`.
- Gate message: `403 Email address is not verified`.
- Existing users are migrated unverified. SMTP failure never fails registration.
- Code comments, test names and commit messages in English.

## Review Focus
- Token reuse after successful verify → `400` (hash cleared). Test in Task 2 and Task 4.
- Resend replaces the token: the old link → `400`. Test in Task 2 and Task 4.
- Already verified user calling resend → `204`, no email sent. Test in Task 2.
- Expired token → `400`, even if the hash still matches. Test in Task 2.
- Uninvited/unverified invite creator → `403` before any invite row is written. Test in Task 3.

---

### Task 1: Schema + mail module

**Files:**
- Create: `src/migrations/Migration20261012100000_AddEmailVerification.ts`
- Modify: `src/entities/user.entity.ts` (3 properties)
- Create: `src/modules/mail/mail-sender.ts` (interface, token, `InMemoryMailSender` for tests)
- Create: `src/modules/mail/smtp-mail-sender.ts`, `src/modules/mail/mail.env.ts`, `src/modules/mail/mail.module.ts`
- Test: `src/modules/mail/mail.env.spec.ts`
- Modify: `docker-compose.yml` (mailpit), `.env.example`, `docs/environment-variables.md`, `test/setup/test-env.ts` (SMTP vars), `package.json` (nodemailer, @types/nodemailer)

**Interfaces — Produces:**
```ts
export const MAIL_SENDER = Symbol('MAIL_SENDER');
export interface MailMessage { to: string; subject: string; text: string; html: string }
export interface MailSender { send(message: MailMessage): Promise<void> }
export class InMemoryMailSender implements MailSender { readonly sent: MailMessage[] }
export function mailConfigFromEnv(env?: NodeJS.ProcessEnv): SmtpConfig // throws on bad env
```
User entity: `email_verified_at?: Date | null`, `email_verification_token_hash?: string | null` (hidden), `email_verification_expires_at?: Date | null`.

- [ ] Step 1: failing `mail.env.spec.ts`: missing `SMTP_HOST`/`MAIL_FROM` throws; `SMTP_PORT` non-numeric throws; `SMTP_SECURE` defaults to false; user/pass optional but must come together.
- [ ] Step 2: run `npx jest src/modules/mail` → FAIL.
- [ ] Step 3: implement env, sender, module (global module exporting `MAIL_SENDER`, factory validates env at bootstrap), migration:
```sql
alter table "users" add column "email_verified_at" timestamptz null,
  add column "email_verification_token_hash" varchar(64) null,
  add column "email_verification_expires_at" timestamptz null;
create unique index "users_email_verification_token_hash_unique"
  on "users" ("email_verification_token_hash") where "email_verification_token_hash" is not null;
-- down: drop index if exists ...; alter table drop column if exists x3
```
- [ ] Step 4: `npx jest src/modules/mail` → PASS; `migration:up`, `migration:down`, `migration:up`.

### Task 2: EmailVerificationService

**Files:**
- Create: `src/modules/auth/email-verification/email-verification.service.ts`, `verification-email.ts` (subject/text/html builder), `email-verification.env.ts`
- Test: `src/modules/auth/email-verification/email-verification.service.spec.ts`

**Interfaces — Produces:**
```ts
class EmailVerificationService {
  issueAndSend(user: Pick<User, 'id' | 'email' | 'first_name'>): Promise<void>; // swallows + logs send errors
  verify(rawToken: string): Promise<string>; // returns userId; BadRequestException otherwise
  resend(userId: string): Promise<'sent' | 'already_verified'>; // HttpException 429 inside cooldown
}
```
Consumes: `MAIL_SENDER`, `EntityRepository<User>`.

- [ ] Step 1: failing unit tests (repo mocked, `InMemoryMailSender`): issue stores sha256 of the token from the mailed link and expiry = now + TTL; mailed link starts with `${FRONTEND_URL}/verify-email?token=`; send failure does not throw; verify with valid token sets `email_verified_at`, clears hash/expiry (via conditional `nativeUpdate` on hash + `expires_at > now`); verify with unknown/expired token → 400; resend for verified user → `already_verified`, nothing sent; resend within 60 s of issue → 429; resend after cooldown overwrites hash.
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: run → PASS.

### Task 3: Soft gate in household invites

**Files:**
- Modify: `src/modules/auth/strategies/jwt.strategy.ts` (select `email_verified_at`), `src/modules/auth/types/jwt-payload.interface.ts` (add to `AuthenticatedUser`)
- Modify: `src/modules/household/household.service.ts` (`createInvite(hid, inviter: Pick<User,'id'|'email_verified_at'>, dto)`, `acceptInvite(token, user: Pick<User,'id'|'email'|'email_verified_at'>)`), `household.controller.ts`
- Test: `src/modules/household/household.service.spec.ts`

- [ ] Step 1: failing tests: createInvite with `email_verified_at: null` → `ForbiddenException('Email address is not verified')` and no transaction; acceptInvite unverified → same 403 before any DB lookup.
- [ ] Step 2: FAIL. Step 3: implement `assertEmailVerified(user)` private helper. Step 4: PASS.

### Task 4: Endpoints, profile flag, e2e

**Files:**
- Create: `src/modules/auth/dto/verify-email.dto.ts` (`token`: hex string, 64 chars)
- Modify: `src/modules/auth/auth.controller.ts`, `auth.service.ts` (register → `issueAndSend`; audit `logAuthAttempt`), `auth.module.ts`, `src/modules/user/user.service.ts` + `dto/user-profile.dto.ts` (`email_verified: boolean`), `src/app.module.ts` (MailModule)
- Modify: `test/utils/app.ts` — `createTestApp` overrides `MAIL_SENDER` with `InMemoryMailSender`; `registerUser(app, label, { verified = true })` marks the user verified via SQL (no throttled request); helper `sentMail(app)`
- Test: `test/auth-email-verification.e2e-spec.ts`; adjust affected unit specs (auth.service.spec, auth.controller.spec, user.service.spec)

- [ ] Step 1: failing e2e: register (unverified) → `me.email_verified === false`, one mail to that address; accept invite → 403; create invite → 403; verify with token from mail → 204; `me.email_verified === true`; accept → succeeds; same token again → 400; garbage token → 400 (validation) ; resend: first token killed after resend (after cooldown, simulated by moving `email_verification_expires_at` back via SQL) → old 400, new 204; resend when verified → 204 and no new mail; resend without JWT → 401.
- [ ] Step 2: `npm run test:e2e -- test/auth-email-verification.e2e-spec.ts` → FAIL. Step 3: implement. Step 4: PASS; run invites/registration e2e specs.

### Task 5: Verification
- [ ] `npm run lint:check && npm run type-check && npm test && npm run build && npm run test:e2e` (output trimmed).
- [ ] Code review (`/tmp/review-P31.diff`, model opus — auth/migration), fix findings, single commit `fix(P31): …`.
