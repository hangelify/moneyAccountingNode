# Frontend Integration: Email Verification Gate

## Overview

This guide is for frontend developers. A user whose email address is not
verified **cannot use the app**. Register and login still return tokens, but
every authenticated endpoint except a few answers `403`:

```json
{ "statusCode": 403, "error": "email_not_verified", "message": "Email address is not verified" }
```

Branch on `error === 'email_not_verified'`, not on the message. It is a `403`,
not a `401`: the token is valid, so **do not** refresh or log the user out.
Users registered before this change are unverified too and see the same gate.

```
 register / login ─▶ GET /auth/me ─┬─ email_verified: true  ─▶ app
                                   └─ email_verified: false ─▶ "Confirm your email" screen
                                                               ├─ Resend ─▶ POST /auth/resend-verification
                                                               └─ Log out ─▶ POST /auth/logout
 any API call ─▶ 403 email_not_verified ─▶ "Confirm your email" screen
```

## Endpoints open to unverified users

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/auth/me` | Profile; read `email_verified` |
| `POST` | `/auth/resend-verification` | Send a new link |
| `POST` | `/auth/logout` | End the current session |
| `POST` | `/auth/logout-all` | End every session |
| `GET` | `/auth/sessions` | List sessions |
| `DELETE` | `/auth/sessions/{id}` | End one session |

Public endpoints work as before: `register`, `login`, `refresh`, `revoke`,
`verify-email`. Everything else, including `POST /auth/change-password`, answers
`403 email_not_verified` until the email is verified.

## The "Confirm your email" screen

- Show the address from `GET /auth/me` and a **Resend** button.
- `POST /auth/resend-verification` answers:
  - `204` — email sent (or the user is already verified: re-check `/auth/me`);
  - `429` — the previous email was sent less than a minute ago; disable the
    button for a minute;
  - `503` — the email could not be sent; let the user retry.
- The link from the email opens `/verify-email?token=…` on the frontend, which
  calls `POST /auth/verify-email` with `{ token }` (`204` on success, `400` for
  an invalid or expired token). It may be opened on another device.
- After verification the **same access token** works at once: no new login is
  needed. Re-check `GET /auth/me` (on focus, or with a "I've confirmed" button)
  and enter the app when `email_verified` is `true`.
