# Frontend Integration: Households

`GET /households`

## Overview

This guide is for frontend developers. It explains what a **household** is, how to
load the user's households with `GET /households`, and how the selected household
drives every other screen of the app.

A household is the unit that owns all financial data. Category limits,
categories, sub-categories, markets and bills all belong to a household, not to a
user. Every member of a household can read and write that data. One user can belong
to several households (for example "Personal" and "Family Budget").

So the frontend always works **inside one household at a time**. Almost every API
path starts with `/households/{hid}/…`. The `hid` comes from `GET /households`.

```
 ┌──────────────┐  login / register   ┌──────────────────────┐
 │ Auth screens │ ──────────────────▶ │ GET /households      │
 └──────────────┘                     │  → [{id, name, …}]   │
                                      └──────────┬───────────┘
                                                 │ pick one (stored or first)
                                                 ▼
                                      ┌──────────────────────┐
                                      │ Active household     │  hid in app state
                                      │ (household switcher) │  + in the URL
                                      └──────────┬───────────┘
                                                 │ every data call uses {hid}
             ┌──────────────┬──────────────┬─────┴────────┬──────────────┐
             ▼              ▼              ▼              ▼              ▼
    /category-limits  /categories  /sub-categories   /markets        /bills
```

Swagger UI with the live schemas is served at `/api` on the backend.

---

## 1. `GET /households`

### 1.1 Contract

| | |
|---|---|
| Method | `GET` |
| Path | `/households` (no global prefix) |
| Auth | `Authorization: Bearer <access_token>` |
| Query | none (no paging, no filters) |
| Success | `200 OK` with a JSON array |

The list holds every household the caller is a **member** of, with any role.
Soft-deleted households are left out. Households of other users never appear.

### 1.2 Response

A plain array (not wrapped in `{ data }`):

```json
[
  {
    "id": "3f6c1a2e-8b1d-4c3e-9a57-0d2f1e6b7a10",
    "name": "Personal",
    "created_at": "2026-06-03T12:00:00.000Z",
    "member_count": 1
  },
  {
    "id": "a9e0b4c2-1f7d-4e8a-b3c5-6d2e9f0a1b24",
    "name": "Family Budget",
    "created_at": "2026-09-14T08:31:12.000Z",
    "member_count": 3
  }
]
```

| Field | Type | Notes |
|---|---|---|
| `id` | UUID string | The `hid` for every household-scoped path |
| `name` | string, 1–255 chars | Display name; owners can rename it |
| `created_at` | ISO 8601 string | When the household was created |
| `member_count` | number | Members, including the owner(s) |

TypeScript type:

```ts
export interface Household {
  id: string;
  name: string;
  created_at: string; // ISO date
  member_count: number;
}
```

### 1.3 What the list does **not** tell you

- **Your role.** The list has no `role` field. To know if the user is the `owner`
  (and may rename, delete or invite), call `GET /households/{hid}` and find the user
  in `members` (see [§4](#4-household-details-and-the-users-role)).
- **Which household is "personal" or "default".** There is no flag for it, and the
  user profile (`GET /auth/me`) has no default household id. The name
  `"Personal"` is only the default name given at registration; the user can rename
  it. Do not use the name to find it.
- **Order.** The backend does not sort the list. Sort it on the client (for example by
  `created_at`, then `name`) so the order stays stable between loads.

### 1.4 Errors

| Status | When | What to do |
|---|---|---|
| `401` | Missing, expired or invalid access token | Refresh the token, then retry; on failure go to login |

An empty array is possible in theory (the user left or deleted every household), even
though registration always creates one. Handle it with an empty state that offers
"Create household" (see [§5.1](#51-create-a-household)).

### 1.5 Example

```ts
export async function fetchHouseholds(api: ApiClient): Promise<Household[]> {
  const res = await api.get<Household[]>('/households');
  return [...res.data].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name),
  );
}
```

---

## 2. Where a user's households come from

| Source | Result |
|---|---|
| Registration (`POST /auth/register`) | The backend creates a household named `"Personal"`, makes the user its `owner` and seeds default categories into it. Every new user therefore has one household right away. |
| `POST /households` | The caller creates a new household and becomes its `owner`. It starts with **no categories**; see [§5.1](#51-create-a-household). |
| Accepting an invite (`POST /households/invites/accept`) | The user joins an existing household as a `member`. |

A user loses a household when they leave it, are removed by an owner, or an owner
soft-deletes it.

---

## 3. The active household

### 3.1 Choosing it

Keep one **active household id** in app state (store, context, or route param). Pick
it on app start, right after login:

1. Call `GET /households`.
2. If a remembered id (from `localStorage` or the URL) is still in the list, use it.
3. Otherwise use the first household of the sorted list.
4. If the list is empty, show the "Create household" empty state.

Always check the remembered id against a fresh list. The user may have been removed
from that household, or it may have been deleted, since the last visit.

```ts
const STORAGE_KEY = 'activeHouseholdId';

export function pickActiveHousehold(
  households: Household[],
  preferredId?: string | null,
): Household | null {
  const remembered = preferredId ?? safeGet(STORAGE_KEY);
  return households.find((h) => h.id === remembered) ?? households[0] ?? null;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
```

### 3.2 Putting `hid` in the URL

Put the household id in the frontend route, for example
`/h/{hid}/dashboard`, `/h/{hid}/bills/{id}`. Then deep links, reloads and
several browser tabs on different households all work, and the API path can be built
straight from the route.

### 3.3 Switching households

Show a household switcher (in the header or side menu) built from the
`GET /households` list. On switch:

1. Set the new active id (state, URL and `localStorage`).
2. **Drop all cached household data** of the previous household: category limits,
   categories, sub-categories, markets, bills, drafts, dashboard. With a
   query library, include `hid` in every query key (for example
   `['households', hid, 'bills', params]`), so the cache is split per household for
   free.
3. Reload the current screen for the new household.

Never send an id of a record (category, market, bill, …) from one household in a
request to another household. The backend answers `404` (see [§6](#6-how-the-backend-protects-household-data)).

### 3.4 When to reload the list

Call `GET /households` again after:

- login, and app start with a stored session;
- creating, renaming or deleting a household;
- accepting an invite;
- leaving a household or removing a member (`member_count` changes);
- any `403` from a `/households/{hid}/…` path (see [§6](#6-how-the-backend-protects-household-data)).

---

## 4. Household details and the user's role

`GET /households/{hid}` returns the household plus its members:

```json
{
  "id": "a9e0b4c2-1f7d-4e8a-b3c5-6d2e9f0a1b24",
  "name": "Family Budget",
  "created_at": "2026-09-14T08:31:12.000Z",
  "member_count": 2,
  "members": [
    {
      "user_id": "…",
      "email": "jane@example.com",
      "first_name": "Jane",
      "last_name": "Doe",
      "role": "owner",
      "joined_at": "2026-09-14T08:31:12.000Z"
    }
  ]
}
```

`last_name` can be missing. Find the current user's role by matching `user_id` with
the `id` from `GET /auth/me`:

```ts
const role = details.members.find((m) => m.user_id === me.id)?.role; // 'owner' | 'member'
```

Use the role only to **show or hide** controls. The backend checks it again on every
call.

| Action | `owner` | `member` |
|---|---|---|
| Read and write all financial data (category limits, bills, …) | ✅ | ✅ |
| View household details and members | ✅ | ✅ |
| Rename household | ✅ | ❌ `403` |
| Delete household | ✅ | ❌ `403` |
| Create, list, revoke invites | ✅ | ❌ `403` |
| Remove another member | ✅ | ❌ `403` |
| Leave the household (remove self) | ✅ unless last owner (`409`) | ✅ |

---

## 5. Other household endpoints

All need `Authorization: Bearer <access_token>`.

| Method | Path | Who | Success | Purpose |
|---|---|---|---|---|
| `GET` | `/households` | any user | `200` | List own households |
| `POST` | `/households` | any user | `201` | Create a household, caller becomes owner |
| `GET` | `/households/{hid}` | member | `200` | Details and member list |
| `PUT` | `/households/{hid}` | owner | `200` | Rename |
| `DELETE` | `/households/{hid}` | owner | `204` | Soft-delete |
| `POST` | `/households/{hid}/invites` | owner | `201` | Create an invite link |
| `GET` | `/households/{hid}/invites` | owner | `200` | List invites |
| `DELETE` | `/households/{hid}/invites/{id}` | owner | `204` | Revoke a pending invite |
| `POST` | `/households/invites/accept` | invitee | `204` | Join through an invite |
| `DELETE` | `/households/{hid}/members/{uid}` | owner, or the member themself | `204` | Remove a member / leave |

### 5.1 Create a household

```http
POST /households
{ "name": "Family Budget" }
```

`name` is required, 1–255 characters. The response has the same shape as a list item,
with `member_count: 1`.

A new household has **no categories**. Registration seeds defaults only into the
"Personal" household. After creating one, offer to add the default categories:

```http
POST /households/{hid}/categories/seed-defaults
```

Then add it to the list, make it active, and go to its first screen.

### 5.2 Rename and delete

- `PUT /households/{hid}` with `{ "name": "…" }` (1–255 characters). Update the name
  in the list and the switcher.
- `DELETE /households/{hid}` soft-deletes it for **all** members. Ask for
  confirmation, then remove it from the list and switch to another household
  ([§3.1](#31-choosing-it)).

### 5.3 Invites

Both sides need a verified email address. `GET /auth/me` has `email_verified`; if
it is `false`, hide or disable the invite actions and point the user to email
verification. Otherwise the backend answers `403 Email address is not verified`.

**Create** (owner):

```http
POST /households/{hid}/invites
{ "email": "jane@example.com" }
```

```json
{
  "token": "<64 hex chars>",
  "invite_url": "https://app.example.com/invite/<token>",
  "expires_at": "2026-11-05T10:00:00.000Z"
}
```

- The token is shown **once**. The backend stores only its hash, so it cannot be
  shown again. The backend does **not** send an email; show the `invite_url` with a
  copy/share button and let the owner send it.
- An invite is valid for 7 days.
- `409` when the household already has the maximum of active (pending, not expired)
  invites. Ask the owner to revoke one first.

**List** (owner): `GET /households/{hid}/invites` returns items with `id`,
`invitee_email`, `status` (`pending`, `accepted`, `revoked`, `expired`), `expires_at`
and `created_at`, newest first.

**Revoke** (owner): `DELETE /households/{hid}/invites/{id}`. Revoking twice is fine;
an accepted invite answers `409`.

**Accept** (invitee): the frontend needs a route `/invite/:token` (the
`invite_url` points to it, based on the backend's `FRONTEND_URL`).

1. If the user is not logged in, send them to login or register and keep the token
   to come back to this route.
2. Call `POST /households/invites/accept` with `{ "token": "<token>" }`.
3. On `204`, reload `GET /households`, make the joined household active and open it.
   The accept response has no body, so find the new household by comparing the list
   before and after.

| Status | Body `reason` | Message to the user |
|---|---|---|
| `400` | – | The link is broken (token is not 64 hex characters) |
| `403` | – | This invite is for another email address, or your email is not verified |
| `409` | `already_member` | You are already in this household; open it |
| `410` | `not_found` | This invite does not exist |
| `410` | `revoked` | The owner revoked this invite |
| `410` | `expired` | This invite has expired; ask for a new one |
| `410` | `already_accepted` | This invite was already used |
| `410` | `household_deleted` | This household no longer exists |

### 5.4 Members: remove and leave

`DELETE /households/{hid}/members/{uid}`:

- An owner may remove any member.
- A member may only remove themself (`uid` = own id). That is "Leave household".
- The last owner cannot leave: `409 Cannot remove the last owner of a household`.
  Suggest deleting the household instead.
- `404` when `uid` is not a member.

After leaving, remove the household from the list and switch to another one.

---

## 6. How the backend protects household data

Every `/households/{hid}/…` path (except `GET /households` itself, `POST /households`
and the invite accept) runs a membership check first:

| Situation | Status |
|---|---|
| `hid` is not a UUID | `403` |
| Household does not exist or is soft-deleted | `403` |
| User is not a member | `403` |
| Member, but the action is owner-only | `403` with a message |
| Record id (bill, category, …) belongs to another household | `404` |

The backend gives the same `403` for "does not exist" and "not yours" on purpose. The
frontend cannot tell them apart, and does not need to.

**Handling a `403` on a household path** (except the owner-only actions above):
the active household is no longer available, for example the user was removed in
another session. Reload `GET /households`, switch to another household, and tell the
user: "You no longer have access to this household."

---

## 7. Where `hid` is used across the app

Every financial feature lives under the active household. Build all of these paths
from the active `hid`.

| Area / screen | Base path | Endpoints |
|---|---|---|
| Household settings, members, invites | `/households/{hid}` | See [§5](#5-other-household-endpoints) |
| Category limits | `/households/{hid}/category-limits` | `GET` (`?include_history=true` lists every version), `POST`, `PUT /{categoryId}`, `DELETE /{categoryId}` (keeps the limit until the end of its current period) |
| Categories | `/households/{hid}/categories` | `POST /seed-defaults`, `POST /bulk`, `POST`, `GET`, `GET /{id}`, `PUT /{id}`, `DELETE /{id}` |
| Sub-categories | `/households/{hid}/sub-categories` | `POST /bulk`, `POST`, `GET`, `GET /{id}`, `PUT /{id}`, `DELETE /{id}` |
| Markets (shops) | `/households/{hid}/markets` | `POST`, `GET`, `GET /{id}`, `PUT /{id}`, `DELETE /{id}` |
| Bills | `/households/{hid}/bills` | `POST`, `GET`, `GET /{id}`, `PUT /{id}`, `DELETE /{id}` |
| Receipt scan and drafts | `/households/{hid}/bills` | `POST /parse-photo`, `GET /drafts`, `GET /drafts/{id}/image`, `POST /{id}/confirm` — see [frontend-parse-photo-integration.md](frontend-parse-photo-integration.md) |
| Dashboard | `/households/{hid}/bills/dashboard` | `GET` |

Notes per area:

- **Shared data.** All members see and edit the same records. Changes by another
  member show up on the next fetch; there is no push.
- **Categories feed bills.** Bill items point to sub-categories of the **same**
  household. The receipt-scan AI matches lines only to that household's
  sub-categories. Load categories and sub-categories per household, never mix them.
- **Receipt photos** are stored per household and are only readable inside it.
- **Endpoints that are not household-scoped:** `/auth/*`, including the user profile `GET /auth/me`.
  User settings such as `currency` and `language_code` belong to the user and are the
  same in every household.

### 7.1 A small API helper

```ts
export function householdPath(hid: string, path = ''): string {
  return `/households/${encodeURIComponent(hid)}${path}`;
}

// usage
api.get(householdPath(hid, '/bills/dashboard'), { params });
api.post(householdPath(hid, '/categories/seed-defaults'));
```

---

## 8. Checklist

- [ ] Call `GET /households` after login and on app start.
- [ ] Sort the list on the client.
- [ ] Keep one active `hid`; check a remembered id against the fresh list.
- [ ] Put `hid` in the frontend route and in every query/cache key.
- [ ] Clear household data on switch.
- [ ] Get the role from `GET /households/{hid}`; hide owner-only actions for members.
- [ ] Offer `seed-defaults` after creating a household.
- [ ] Show the invite link once with a copy button; it is not emailed.
- [ ] Add the `/invite/:token` route and handle every `409`/`410` reason.
- [ ] On `403` from a household path, reload the list and switch household.
- [ ] Handle an empty list with a "Create household" state.
