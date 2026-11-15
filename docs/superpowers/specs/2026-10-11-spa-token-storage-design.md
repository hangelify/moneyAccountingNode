# P27 · SPA refresh-token storage: HttpOnly cookie + CSRF

Status: approved design · Date: 2026-10-11 · Depends on: P26

## Problem

- `/auth/login`, `/auth/register` and `/auth/refresh` return the 7-day refresh
  token in the JSON body. The SPA on `FRONTEND_URL` has to keep it in
  JS-readable storage, so a single XSS steals a long-lived credential.
- Refresh-token rotation with reuse detection only helps if the legitimate
  client uses the token again; an abandoned tab is not protected.
- CORS is configured with `credentials: true` although no cookies are used.

## Decision

Option A: the refresh token lives in an `HttpOnly` cookie for browsers; the
access token stays in SPA memory. Native mobile clients keep receiving the
refresh token in the response body via an explicit mode that browsers cannot
select. (Option B, a BFF, was rejected as a new service out of scope.)

Deployment assumption: SPA and API are same-site (e.g. `app.example.com` and
`api.example.com`, or `localhost:5173` and `localhost:3000` locally), so
`SameSite=Strict` works and is not configurable.

## Client mode resolution

Applied to `POST /auth/login`, `/auth/register`, `/auth/refresh`, `/auth/logout`
by a pure function in `src/modules/auth/client-mode.ts`:

| Request | Result |
|---|---|
| `X-Client-Type: mobile`, no `Origin` | `mobile` |
| `X-Client-Type: mobile` with any `Origin` | 403 |
| no `X-Client-Type`, `Origin` equals `FRONTEND_URL` | `web` |
| no `X-Client-Type`, `Origin` host equals the request `Host` (same-origin, e.g. Swagger UI at `/api`) | `web` |
| no `X-Client-Type`, foreign or missing `Origin` | 403 |
| any other `X-Client-Type` value | 400 |

Rationale: browsers always attach `Origin` to POST requests and page scripts
cannot remove or forge it, so an XSS payload can neither opt into the body
mode nor send a cross-site request that passes the origin check. Native apps
send no `Origin`.

## Web mode

- login/register/refresh set cookie `refresh_token` with
  `HttpOnly; Secure; SameSite=Strict; Path=/auth; Max-Age=<refresh token lifetime>`.
- The body contains `access_token`, `token_type`, `expires_in`; no
  `refresh_token` (`TokenResponseDto.refresh_token` becomes optional).
- `/auth/refresh` reads the token only from the cookie; a missing cookie is
  401. Rotation and reuse detection are unchanged.
- `/auth/logout` still requires the Bearer access token; it takes the refresh
  token from the cookie to find the session, revokes it and clears the cookie
  with the same attributes.
- `Secure` is always set: Chrome and Firefox accept Secure cookies on
  `http://localhost`.

## Mobile mode

Unchanged behaviour (refresh token in body for login/register/refresh, in the
optional body for logout), but the client must now send
`X-Client-Type: mobile`. This is a breaking change for existing native
clients. No cookie is set.

## Infrastructure

- `cookie-parser` is registered in `configureApp` (shared by `main.ts` and e2e).
- CORS keeps `credentials: true` (now needed for the cookie).
- Swagger: `X-Client-Type` documented as an optional header; refresh documents
  the cookie.

## Frontend changes (not in this repo; documented in README)

- Call `/auth/*` with `fetch(..., { credentials: 'include' })`.
- Keep the access token only in memory; on page load or a 401, call
  `POST /auth/refresh` without a body.
- Stop storing tokens in `localStorage`/`sessionStorage`.

## Testing

- Unit: `client-mode` resolution table.
- e2e: login sets the cookie with the required flags and the body has no
  `refresh_token`; refresh via cookie works; foreign `Origin` → 403;
  logout clears the cookie; mobile mode returns body tokens;
  `mobile` + `Origin` → 403. Existing e2e that read `refresh_token` from the
  body switch to mobile mode.

## Risks

- Safari does not keep `Secure` cookies on `http://localhost`; local
  development in Safari needs HTTPS.
- Same-origin detection trusts the `Host` header (browsers do not let scripts
  set it).
- If SPA and API are ever deployed cross-site, `SameSite=Strict` cookies will
  not be sent and the design must be revisited.
