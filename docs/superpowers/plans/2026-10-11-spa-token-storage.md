# SPA Refresh-Token Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browsers get the refresh token only as an `HttpOnly; Secure; SameSite=Strict; Path=/auth` cookie with an `Origin` check; native clients opt into body tokens with `X-Client-Type: mobile`.

**Architecture:** A pure `resolveClientMode(req)` decides `web` / `mobile` / 403 / 400 from `X-Client-Type`, `Origin`, `Host` and `FRONTEND_URL`. A small `refresh-cookie` module owns cookie attributes. `AuthController` calls both in login/register/refresh/logout (inside the handler, so `ValidationPipe` still runs first); `AuthService` is unchanged.

**Tech Stack:** NestJS 11 (Express), cookie-parser, Jest, supertest.

**Spec:** `docs/superpowers/specs/2026-10-11-spa-token-storage-design.md`

## Global Constraints

- Cookie name `refresh_token`; attributes `HttpOnly; Secure; SameSite=Strict; Path=/auth`; `Max-Age` = `JWT_REFRESH_EXPIRES_IN_MS / 1000`.
- Mode header `X-Client-Type`, only accepted value `mobile` (case-insensitive); anything else → 400.
- Allowed web origins: `FRONTEND_URL` (fallback `http://localhost:5173`, same as CORS) and the API's own origin (`Origin` host === request `Host`).
- English only for code, comments, test names, commit message.
- `AuthService` signatures and rotation/reuse-detection logic do not change.

## Review Focus

1. `FRONTEND_URL` with trailing slash or path (`http://localhost:5173/`) — must still match `Origin: http://localhost:5173` (compare `new URL(...).origin`).
2. `Origin: null` (sandboxed iframe, file://) — must be 403, not a crash in `new URL`.
3. Web refresh with a JSON body containing `refresh_token` but no cookie — must be 401; the body token must never be used in web mode.
4. Mobile refresh without body token — 400 from the controller, not a 500.
5. Logout in web mode with a cookie belonging to another user — session targeting falls back to `sid` (existing service check), cookie still cleared.

---

### Task 1: Client mode resolution

**Files:**
- Create: `src/modules/auth/client-mode.ts`
- Test: `src/modules/auth/client-mode.spec.ts`

**Interfaces:**
- Produces: `export type ClientMode = 'web' | 'mobile'`; `export const CLIENT_TYPE_HEADER = 'x-client-type'`; `export function resolveClientMode(req: Pick<Request, 'get'>): ClientMode` — throws `ForbiddenException` / `BadRequestException`.

- [ ] **Step 1: Write the failing test**

```ts
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { resolveClientMode } from './client-mode';

const req = (headers: Record<string, string>) => ({
  get: (name: string) => headers[name.toLowerCase()],
});

describe('resolveClientMode', () => {
  const original = process.env.FRONTEND_URL;
  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://app.example.com/';
  });
  afterAll(() => {
    process.env.FRONTEND_URL = original;
  });

  it('returns mobile for X-Client-Type: mobile without Origin', () => {
    expect(resolveClientMode(req({ 'x-client-type': 'Mobile' }))).toBe('mobile');
  });

  it('rejects mobile mode when the request carries an Origin', () => {
    expect(() =>
      resolveClientMode(
        req({ 'x-client-type': 'mobile', origin: 'https://app.example.com' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects unknown client types', () => {
    expect(() => resolveClientMode(req({ 'x-client-type': 'desktop' }))).toThrow(
      BadRequestException,
    );
  });

  it('returns web for the frontend origin', () => {
    expect(resolveClientMode(req({ origin: 'https://app.example.com' }))).toBe('web');
  });

  it('returns web for a same-origin request', () => {
    expect(
      resolveClientMode(req({ origin: 'http://localhost:3000', host: 'localhost:3000' })),
    ).toBe('web');
  });

  it.each([
    ['a foreign origin', { origin: 'https://evil.example', host: 'api.example.com' }],
    ['a missing origin', { host: 'api.example.com' }],
    ['a null origin', { origin: 'null', host: 'api.example.com' }],
    ['a malformed origin', { origin: 'not a url', host: 'api.example.com' }],
  ])('rejects web mode with %s', (_label, headers) => {
    expect(() => resolveClientMode(req(headers))).toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx jest src/modules/auth/client-mode.spec.ts 2>&1 | tail -n 20` → "Cannot find module './client-mode'".

- [ ] **Step 3: Implement**

```ts
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

export type ClientMode = 'web' | 'mobile';

export const CLIENT_TYPE_HEADER = 'x-client-type';

// Browsers always send Origin on POST and scripts cannot drop or forge it, so
// an XSS payload can neither opt into body tokens nor pass the origin check
// from another site. Native apps send no Origin and ask for mobile mode.
export function resolveClientMode(req: Pick<Request, 'get'>): ClientMode {
  const clientType = req.get(CLIENT_TYPE_HEADER);
  const origin = req.get('origin');

  if (clientType !== undefined) {
    if (clientType.toLowerCase() !== 'mobile') {
      throw new BadRequestException(
        `Unsupported ${CLIENT_TYPE_HEADER} header; the only accepted value is "mobile"`,
      );
    }
    if (origin !== undefined) {
      throw new ForbiddenException('Mobile client mode is not available to browsers');
    }
    return 'mobile';
  }

  if (origin !== undefined && isAllowedWebOrigin(origin, req.get('host'))) {
    return 'web';
  }
  throw new ForbiddenException('Request origin is not allowed');
}

function isAllowedWebOrigin(origin: string, host: string | undefined): boolean {
  const parsed = parseOrigin(origin);
  if (!parsed) {
    return false;
  }
  const frontend = parseOrigin(process.env.FRONTEND_URL || 'http://localhost:5173');
  return parsed.origin === frontend?.origin || parsed.host === host;
}

function parseOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.origin === 'null' ? undefined : url;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run, expect PASS** — same command.

---

### Task 2: Refresh cookie helpers + cookie-parser

**Files:**
- Create: `src/modules/auth/refresh-cookie.ts`
- Test: `src/modules/auth/refresh-cookie.spec.ts`
- Modify: `src/app.setup.ts` (register `cookieParser()` before CORS), `package.json` (`npm install cookie-parser && npm install -D @types/cookie-parser`)

**Interfaces:**
- Produces: `export const REFRESH_COOKIE = 'refresh_token'`; `setRefreshCookie(res: Response, token: string): void`; `clearRefreshCookie(res: Response): void`; `readRefreshCookie(req: Request): string | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
import type { Request, Response } from 'express';
import {
  clearRefreshCookie,
  readRefreshCookie,
  REFRESH_COOKIE,
  setRefreshCookie,
} from './refresh-cookie';

describe('refresh cookie', () => {
  const original = process.env.JWT_REFRESH_EXPIRES_IN_MS;
  beforeAll(() => {
    process.env.JWT_REFRESH_EXPIRES_IN_MS = '604800000';
  });
  afterAll(() => {
    process.env.JWT_REFRESH_EXPIRES_IN_MS = original;
  });

  const attributes = {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/auth',
  };

  it('sets an HttpOnly, Secure, SameSite=Strict cookie scoped to /auth', () => {
    const res = { cookie: jest.fn() } as unknown as Response;
    setRefreshCookie(res, 'token');
    expect(res.cookie).toHaveBeenCalledWith(REFRESH_COOKIE, 'token', {
      ...attributes,
      maxAge: 604800000,
    });
  });

  it('clears the cookie with the same attributes', () => {
    const res = { clearCookie: jest.fn() } as unknown as Response;
    clearRefreshCookie(res);
    expect(res.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE, attributes);
  });

  it('reads only non-empty string cookies', () => {
    const read = (cookies: unknown) => readRefreshCookie({ cookies } as Request);
    expect(read({ refresh_token: 'abc' })).toBe('abc');
    expect(read({ refresh_token: '' })).toBeUndefined();
    expect(read(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx jest src/modules/auth/refresh-cookie.spec.ts 2>&1 | tail -n 20`.

- [ ] **Step 3: Implement**

```ts
import type { CookieOptions, Request, Response } from 'express';
import { requireIntEnv } from './auth.env';

export const REFRESH_COOKIE = 'refresh_token';

// Chrome and Firefox accept Secure cookies on http://localhost, and
// localhost:5173 and localhost:3000 are the same site, so these attributes
// also work in local development.
const ATTRIBUTES: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/auth',
};

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...ATTRIBUTES,
    maxAge: requireIntEnv('JWT_REFRESH_EXPIRES_IN_MS'),
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, ATTRIBUTES);
}

export function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[
    REFRESH_COOKIE
  ];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
```

In `src/app.setup.ts`: `import cookieParser from 'cookie-parser';` and `app.use(cookieParser());` right after `applyTrustProxy`.

- [ ] **Step 4: Run, expect PASS**; `npm run type-check 2>&1 | tail -n 20`.

---

### Task 3: Controller wiring, DTOs, Swagger, existing e2e to mobile mode

**Files:**
- Modify: `src/modules/auth/auth.controller.ts` (register/login/refresh/logout)
- Modify: `src/modules/auth/dto/refresh-token.dto.ts` (`refresh_token` optional, `@IsOptional()`; description: required in mobile mode, ignored in web mode)
- Modify: `src/modules/auth/dto/token-response.dto.ts` (`refresh_token?: string`, `required: false`, description: mobile mode only)
- Modify: `src/modules/auth/dto/logout.dto.ts` (description: mobile mode only)
- Modify e2e to send `X-Client-Type: mobile` on every `POST /auth/{login,register,refresh,logout}`: `test/utils/app.ts`, `test/auth-flow.e2e-spec.ts`, `test/auth-token-standards.e2e-spec.ts`, `test/auth-registration.e2e-spec.ts`, `test/auth-login.e2e-spec.ts`, `test/trust-proxy.e2e-spec.ts`, `test/app.e2e-spec.ts` (POST only; OPTIONS/CORS tests unchanged)

**Interfaces:**
- Consumes: `resolveClientMode`, `setRefreshCookie`, `clearRefreshCookie`, `readRefreshCookie`.
- Produces: HTTP contract from the spec.

- [ ] **Step 1: Red** — run `npx jest --config ./test/jest-e2e.json test/auth-flow.e2e-spec.ts 2>&1 | grep -E "✕|Tests:"` after adding `X-Client-Type: mobile` to its helpers: still green (header is ignored today). The red step for the controller is Task 4's e2e; write Task 4's spec first if executing strictly TDD.

- [ ] **Step 2: Implement the controller**

Shared private helper:

```ts
  // Web clients get the refresh token only as an HttpOnly cookie; mobile
  // clients (no Origin, explicit header) keep receiving it in the body.
  private deliverTokens(
    mode: ClientMode,
    tokens: TokenResponseDto,
    res: Response,
  ): TokenResponseDto {
    if (mode === 'mobile') {
      return tokens;
    }
    const { refresh_token: refreshToken, ...body } = tokens;
    setRefreshCookie(res, refreshToken!);
    return body;
  }
```

`login` (register is identical, with `registerDto`):

```ts
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponseDto> {
    const mode = resolveClientMode(req);
    const ipAddress = this.extractIpAddress(req);
    const userAgent = req.get('user-agent');
    const tokens = await this.authService.login(loginDto, ipAddress, userAgent);
    return this.deliverTokens(mode, tokens, res);
  }
```

`refresh`:

```ts
    const mode = resolveClientMode(req);
    const refreshToken =
      mode === 'web' ? readRefreshCookie(req) : refreshTokenDto.refresh_token;
    if (!refreshToken) {
      throw mode === 'web'
        ? new UnauthorizedException('Missing refresh token cookie')
        : new BadRequestException('refresh_token is required');
    }
    const tokens = await this.authService.refreshToken(refreshToken, ipAddress, userAgent);
    return this.deliverTokens(mode, tokens, res);
```

`logout`:

```ts
    const mode = resolveClientMode(req);
    const refreshToken =
      mode === 'web' ? readRefreshCookie(req) : logoutDto.refresh_token;
    await this.authService.logout(user.id, user.sid, refreshToken, ipAddress, userAgent);
    if (mode === 'web') {
      clearRefreshCookie(res);
    }
    return { message: 'Logged out successfully' };
```

Swagger on the four endpoints: `@ApiHeader({ name: 'X-Client-Type', required: false, description: 'Set to "mobile" (native apps only, no Origin) to receive the refresh token in the body instead of a cookie' })`, `@ApiResponse({ status: 403, description: 'Origin not allowed for this client mode' })`; on refresh `@ApiCookieAuth('refresh-cookie')` and in `app.setup.ts` `.addCookieAuth('refresh_token', { type: 'apiKey', in: 'cookie' }, 'refresh-cookie')`. Update the Swagger description text in `app.setup.ts` to mention the cookie.

Check `TokenResponseDto` returned by `AuthService` still compiles with the optional field (`tokens.refresh_token!` where the service reads it internally, if any).

- [ ] **Step 3: Update existing e2e** — add `.set('X-Client-Type', 'mobile')` to every auth POST listed above (in `auth-flow.e2e-spec.ts` via its `refresh`/`login` helpers and logout calls).

- [ ] **Step 4: Run** — `npx jest src/modules/auth 2>&1 | grep -E "✕|Tests:"` and the touched e2e files with `npm run test:e2e -- <files> 2>&1 | grep -E "✕|●|Tests:"`; all green.

---

### Task 4: Web-mode e2e

**Files:**
- Create: `test/auth-web-mode.e2e-spec.ts`

- [ ] **Step 1: Write tests** (using `createTestApp`, `registerUser`, `resetThrottling`; `FRONTEND_URL` from the e2e env, default `http://localhost:5173`)

```ts
const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5173';
const web = (r: request.Test) => r.set('Origin', FRONTEND);
const refreshCookie = (res: request.Response) =>
  ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((c) => c.startsWith('refresh_token='));
```

Cases:
1. `login sets an HttpOnly Secure SameSite=Strict cookie on /auth and omits refresh_token from the body` — cookie matches `/HttpOnly/`, `/Secure/`, `/SameSite=Strict/`, `/Path=\/auth/`, `/Max-Age=\d+/`; `res.body.refresh_token` undefined; `access_token` defined.
2. `refresh with the cookie returns a new access token and rotates the cookie` — new cookie value differs from the old one; old cookie then → 401 (reuse detection).
3. `refresh ignores a body refresh_token in web mode` — no cookie, body has a valid mobile-issued token → 401.
4. `rejects login and refresh from a foreign Origin with 403` — `Origin: https://evil.example`, both 403, no `set-cookie`.
5. `rejects mobile mode when an Origin is present` — 403.
6. `rejects requests without Origin or client type` — 403.
7. `logout clears the cookie and revokes the session` — `set-cookie` has `refresh_token=;` with `Expires=Thu, 01 Jan 1970`; refresh with the old cookie → 401.
8. `mobile mode returns refresh_token in the body and sets no cookie`.
9. `Swagger same-origin requests are accepted` — `Origin: http://<host header>`, `Host` set explicitly → 200.

- [ ] **Step 2: Run** — `npm run test:e2e -- test/auth-web-mode.e2e-spec.ts 2>&1 | grep -E "✕|●|Tests:"` → green (if executed before Task 3, red with 201/200 instead of 403 and body refresh_token present).

---

### Task 5: Docs

**Files:**
- Modify: `README.md` — new section "Web and mobile authentication modes" (mode table, cookie attributes, CSRF rule, frontend checklist: `credentials: 'include'`, access token in memory, refresh on load/401, Safari-on-http-localhost caveat); update "Authenticating in Swagger UI"; `FRONTEND_URL` row: also the allowed Origin for web-mode auth.
- Modify: `docs/environment-variables.md` `FRONTEND_URL` entry if present.

---

### Task 6: Verification and review

- [ ] `npm run lint:check && npm run type-check && npm test 2>&1 | grep -E "✕|Tests:|error"`, `npm run build`, `npm run test:e2e 2>&1 | grep -E "✕|●|Tests:"`.
- [ ] Code review (opus, auth/security) with `/tmp/review-P27.diff`.
- [ ] Single commit `fix(P27): ...` including spec and plan.
