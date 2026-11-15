# P31 · Email verification and MFA — design

## Goal
Tie an account to the real owner of its email address, so that registering with
someone else's address does not grant access to household invites issued to that
address (P22). Plan TOTP-based MFA as a separate, later iteration.

## Decisions (agreed with user)
- Mail transport: SMTP via `nodemailer`. Mailpit in `docker-compose.yml` for local
  development. E2E tests replace the sender with an in-memory fake (no SMTP in CI).
- **Superseded (2026-11-03):** the soft gate below is replaced by a hard gate, see
  `2026-11-03-email-verification-hard-gate-design.md`. Unverified users now get
  403 `email_not_verified` on every authenticated endpoint except profile,
  resend, logout and sessions.
- Soft gate: register/login keep issuing tokens and the personal household works.
  Only email-bound actions require a verified address: accepting and creating
  household invites.
- Existing users are migrated as **unverified** (`email_verified_at = NULL`). Under
  the soft gate they only lose invites until they verify.
- Token storage: columns on `users`, one active token per user.
- `resend-verification` is authenticated (JWT); there is no public "resend by email".
- MFA is planned here and implemented only in a separate iteration.

## Iteration 1 — email verification

### Data
Migration on `users`:
- `email_verified_at timestamptz NULL`
- `email_verification_token_hash varchar(64) NULL` — partial unique index
  `WHERE email_verification_token_hash IS NOT NULL`
- `email_verification_expires_at timestamptz NULL`
- `email_verification_sent_at timestamptz NULL` — when the active token was
  emailed; the resend cooldown is based on it (not on the expiry, which would
  break if the TTL setting changes)

All existing rows stay NULL. `down` drops the index and the columns.
There is no email-change endpoint, so verification is only started at registration
and by resend.

### Token
- Raw token: `randomBytes(32).toString('hex')`; only its SHA-256 hex is stored.
- TTL: `EMAIL_VERIFICATION_TTL_HOURS` (default 24).
- Link in the email: `${FRONTEND_URL}/verify-email?token=<raw>`. The frontend
  calls `POST /auth/verify-email`.

### Endpoints
- `POST /auth/register` — unchanged contract (returns tokens). After the user
  transaction commits, a token is issued and the email is sent. An SMTP failure is
  logged and does not fail registration; the user can resend.
- `POST /auth/verify-email` `{ token }` — public (the link may be opened on another
  device). Finds the user by token hash with `expires_at > now()`, sets
  `email_verified_at = now()`, clears hash and expiry. Unknown, expired or already
  used token → `400 Invalid or expired verification token` (cases are not
  distinguished). Throttle 10 / 60 s. Response `204`.
- `POST /auth/resend-verification` — `JwtAuthGuard`. Already verified → `204`, no
  email. Otherwise a new token replaces the old one (the old link stops working)
  and the email is sent. Throttle 3 / 60 s plus a per-user cooldown of 60 s
  since `email_verification_sent_at` → `429`. "Not verified" and the cooldown
  are conditions of one UPDATE, so concurrent resends cannot both send. If the
  email cannot be sent, the new token is dropped (no cooldown left behind) and
  the answer is `503`. Response `204`.
- `GET /auth/me` and the user profile gain `email_verified: boolean`.
- Verification and resend are written to the auth audit log (`logAuthAttempt`).

### Components
- `src/modules/mail`: `MailSender` interface
  (`send({ to, subject, text, html }): Promise<void>`) bound to the `MAIL_SENDER`
  token; `SmtpMailSender` implementation on nodemailer with bounded timeouts
  (connection/greeting 10 s, socket 20 s), so an unreachable server cannot
  stall registration. SMTP errors are logged by code only (they may quote the
  address). Env, validated at startup
  in the style of `auth.env.ts`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`
  (default false), optional `SMTP_USER` / `SMTP_PASS`, `MAIL_FROM`.
- `EmailVerificationService` in the auth module: `issueAndSend(user)`,
  `verify(rawToken)`, `resend(userId)`. The email body (text + html) is a plain
  function in the auth module; no template engine. It contains no user input
  (not even the first name): anyone can register any address, so user text in
  the body would let them send arbitrary text from our domain.
- Failed verification attempts are audited too.
- Gate: `HouseholdService.createInvite` and `acceptInvite` throw
  `403 Email address is not verified` when `email_verified_at` is NULL. No generic
  guard — two call sites only.

### Testing
- Unit: `EmailVerificationService` (hash only stored, TTL, single use, resend
  invalidates the old token, cooldown, SMTP failure swallowed on register);
  household gate.
- E2E `test/auth-email-verification.e2e-spec.ts` with a fake `MAIL_SENDER`:
  register → email captured → accept invite `403` → verify `204` → accept succeeds;
  reused / expired / unknown token `400`; resend invalidates the previous link;
  `me.email_verified` flips. Existing invite e2e tests verify their users through a
  helper.
- Docs: `.env.example`, `docs/environment-variables.md`.

## Iteration 2 — MFA (plan only, ~1.5 days)
- Library: `otplib`, TOTP, 30 s step, ±1 step window.
- Storage on `users`: `mfa_totp_secret_enc` (AES-256-GCM, key `MFA_ENCRYPTION_KEY`;
  encrypted, not hashed, because verification needs the secret), `mfa_enabled_at`,
  `mfa_last_used_step` (rejects replay of a code). Table `user_mfa_backup_codes`
  (`user_id`, `code_hash` SHA-256, `used_at`), 10 codes.
- Enroll (JWT + verified email + current password):
  `POST /auth/mfa/enroll` → secret and `otpauth://` URI (frontend renders the QR);
  `POST /auth/mfa/enroll/confirm { code }` → enables MFA and returns the backup
  codes once.
- Login: with MFA enabled `POST /auth/login` returns
  `200 { mfa_required: true, mfa_token }` — a 5-minute JWT with `typ: 'mfa'` that
  `JwtAuthGuard` rejects. `POST /auth/mfa/verify { mfa_token, code | backup_code }`
  returns the normal token response / web-mode cookie. Failures count toward the
  existing per-account login lockout (P30).
- `POST /auth/mfa/disable { password, code }` disables MFA and revokes other
  sessions; `POST /auth/mfa/backup-codes { code }` regenerates backup codes.
- Out of scope: self-service recovery without device and backup codes (support).

## Risks
- The token travels in the query string of the frontend URL. The frontend must
  remove it from the address bar after reading it (`history.replaceState`), keep
  it out of analytics, and serve the page with `Referrer-Policy: no-referrer`.
- Existing users must verify before using invites; the frontend needs a banner and
  a "resend" button, and a `/verify-email` page.
- Email deliverability (SPF/DKIM) depends on the SMTP provider chosen in deployment.
