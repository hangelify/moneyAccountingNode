# Frontend Integration: Deleting a Bill

`DELETE /households/{hid}/bills/{id}`

## Overview

This guide is for frontend developers who add a **delete** action to bills. The
same endpoint deletes a bill of **any status**:

| `status` | Where the user deletes it | Suggested wording |
|---|---|---|
| `confirmed` | Bills list, bill detail | "Delete bill" |
| `draft` | Review screen, drafts list | "Discard draft" |
| `duplicate` | Bills list with `include_duplicates=true`, bill detail | "Delete copy" |

The delete is a **soft delete**. The backend sets `deleted_at` on the bill and keeps
the row. From that moment the bill is gone for every API: it no longer appears in
lists, the dashboard, the spending breakdown, duplicate suggestions or the drafts
list, and every call on its `id` answers `404`. There is **no restore endpoint**, so
for the user the delete is final.

```
 bills list / bill detail ─┐
                           ├─▶ confirm dialog ─▶ DELETE .../bills/{id} ─▶ 204 No Content
 review screen (draft)  ───┘                                          └─▶ refresh lists + dashboard
```

Related endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/households/{hid}/bills?include_duplicates=` | List confirmed bills (and duplicates on request) |
| `GET` | `/households/{hid}/bills/drafts?page=&limit=` | List open drafts |
| `GET` | `/households/{hid}/bills/{id}` | Get one bill (any status) |
| `GET` | `/households/{hid}/bills/dashboard` | Dashboard totals |
| `GET` | `/households/{hid}/bills/dashboard/spending-breakdown` | Category tree |
| `GET` | `/households/{hid}/bills/duplicate-suggestions` | Pairs that look like the same purchase |
| `DELETE` | `/households/{hid}/bills/{id}` | **Delete the bill** (this guide) |

Swagger UI with the live schemas is served at `/api` on the backend.

---

## 1. Request

### 1.1 Contract

| | |
|---|---|
| Method | `DELETE` |
| Path | `/households/{hid}/bills/{id}` (no global prefix) |
| `hid` | Household uuid. The user must be a member (any role: `owner` or `member`). |
| `id` | Bill uuid, any status (`draft`, `confirmed`, `duplicate`) |
| Auth | `Authorization: Bearer <access_token>` |
| Body | None. Don't send one. |
| Query | None |
| Success | `204 No Content`, **empty body** |

Who may delete: **any member** of the household, not only the person who created or
confirmed the bill. If your UI hides the action for some users, that is a product
choice; the backend does not enforce it.

### 1.2 Example

```http
DELETE /households/5f0c1e2a-8b7d-4c3e-9a1b-2c3d4e5f6a7b/bills/123e4567-e89b-12d3-a456-426614174000 HTTP/1.1
Authorization: Bearer eyJhbGciOi...
```

```http
HTTP/1.1 204 No Content
```

### 1.3 Client function

```ts
// api/bills.ts
export async function deleteBill(hid: string, id: string): Promise<void> {
  const res = await apiFetch(`/households/${hid}/bills/${id}`, {
    method: 'DELETE',
  });
  // 204 has no body: do not call res.json() on success.
  if (res.status === 204) return;
  throw await toApiError(res); // see §3
}
```

If you use axios, `response.data` is an empty string on `204`; ignore it.

---

## 2. What the delete does (and doesn't do)

| After `204` | Effect |
|---|---|
| `GET /bills`, `GET /bills?include_duplicates=true`, `GET /bills/drafts` | The bill is no longer listed |
| `GET /bills/dashboard`, `GET /bills/dashboard/spending-breakdown` | Totals and the bill list no longer include the bill |
| `GET /bills/duplicate-suggestions` | Pairs with the bill are gone |
| `GET /bills/{id}` | `404` |
| `PUT /bills/{id}`, `POST /bills/{id}/confirm` | `404` |
| `POST /bills/{id}/mark-duplicate`, and any `mark-duplicate` with `duplicate_of_id` = the deleted bill | `404` |
| `GET /bills/drafts/{id}/image` | `404` (draft photo URL no longer served) |
| `DELETE /bills/{id}` again | `404` (not idempotent, see §3.1) |

### 2.1 Duplicates

How the delete affects totals depends on the status:

| Deleted bill | Totals change? | Side effect |
|---|---|---|
| `confirmed`, no copies | Yes, its amount leaves the totals | None |
| `confirmed`, has `duplicate` copies | **No** | The oldest live copy is **promoted**: it becomes `confirmed`, its `duplicate_of` becomes `null`, and the other copies now point to it. The purchase stays counted once. |
| `duplicate` | No (copies are never counted) | The original is untouched |
| `draft` | No (drafts are never counted) | None |

So after deleting an original that had copies, the bill list still shows the
purchase, but under a **different `id`** (the promoted copy). Don't assume the list
shrank by one row: refetch it. Refetch any open detail screen of a copy too, since
its `status` or `duplicate_of` may have changed.

If your UI warns before deleting an original, you can say: "This bill has copies. The
oldest copy will become the main bill." See
[frontend-duplicate-bills-integration.md](frontend-duplicate-bills-integration.md)
§9.

Things the FE should know:

- **Bill items go with the bill.** The lines are not deleted separately and there
  is no endpoint to delete a single line. To remove one line of a draft, drop it
  from `items` in the confirm request (see
  [frontend-confirm-bill-integration.md](frontend-confirm-bill-integration.md)).
- **Markets and sub-categories are not touched.** A market created for this bill
  stays in the household's market list.
- **Re-uploading the same receipt photo after discarding its draft makes a new
  draft.** While a draft is open, re-uploading the same photo returns that draft
  (`duplicate: true`). Once the draft is deleted, the same photo is parsed again as
  a new draft, and that counts toward the user's AI usage. Don't tell the user that
  discarding is free to redo.
- **Unconfirmed drafts are also deleted automatically** after 30 days by default
  (`DRAFT_RETENTION_DAYS` on the backend). This is the same soft delete, so a draft
  can disappear without any user action; handle the `404` as in §3.

---

## 3. Errors

All errors use the standard NestJS body:

```ts
interface ApiError {
  statusCode: number;
  message: string;  // e.g. "Bill with ID … not found"
  error?: string;   // e.g. "Not Found"; absent on 401 and 403
}
```

| Status | Body example | When | What to do |
|---|---|---|---|
| `400` | `{"statusCode":400,"message":"Validation failed (uuid is expected)","error":"Bad Request"}` | `id` in the path is not a uuid | Bug in the caller; don't show to the user as-is |
| `401` | `{"statusCode":401,"message":"Unauthorized"}` | Token missing or expired. The response has a `WWW-Authenticate: Bearer …` header | Refresh the token and retry once, else log in |
| `403` | `{"statusCode":403,"message":"Forbidden"}` | Not a member of household `hid`, the household was deleted, or `hid` is not a uuid | Go to the household picker |
| `404` | `{"statusCode":404,"message":"Bill with ID … not found","error":"Not Found"}` | Bill doesn't exist, was already deleted (by anyone, or by the draft cleanup), or belongs to another household | Treat as success, see below |
| `500` | `{"statusCode":500,"message":"Internal server error"}` | Server failure | Show a generic error, keep the bill in the UI, allow retry |

### 3.1 Treat `404` as "already deleted"

The endpoint is **not idempotent**: a second `DELETE` on the same bill answers
`404`, not `204`. This happens in normal use:

- a retry after a network timeout, where the first request did go through;
- a double click on the delete button;
- another household member, or another tab, deleted it first;
- the draft cleanup removed an old draft.

In all these cases the bill is gone, which is what the user wanted. So on `404`:
remove the bill from local state and refresh lists, exactly as on `204`. Show at
most a soft note ("This bill was already deleted").

```ts
export async function deleteBillIdempotent(hid: string, id: string): Promise<void> {
  try {
    await deleteBill(hid, id);
  } catch (e) {
    if (isApiError(e) && e.statusCode === 404) return; // already gone
    throw e;
  }
}
```

---

## 4. After success

Invalidate everything that may contain the bill. With TanStack Query, for example:

```ts
const queryClient = useQueryClient();

const deleteMutation = useMutation({
  mutationFn: ({ hid, id }: { hid: string; id: string }) =>
    deleteBillIdempotent(hid, id),
  onSuccess: (_data, { hid, id }) => {
    queryClient.removeQueries({ queryKey: ['households', hid, 'bills', id] });
    queryClient.invalidateQueries({ queryKey: ['households', hid, 'bills'] });   // list
    queryClient.invalidateQueries({ queryKey: ['households', hid, 'drafts'] });  // drafts + badge
    queryClient.invalidateQueries({ queryKey: ['households', hid, 'dashboard'] });         // + spending breakdown
    queryClient.invalidateQueries({ queryKey: ['households', hid, 'duplicate-suggestions'] });
  },
});
```

Adapt the keys to your app. Then:

- On the bill detail or review screen, navigate back to the list it came from.
- In a list, the row can be removed optimistically, but put it back if the request
  fails with anything other than `404`.

**Pagination.** Deleting a row shifts the following rows one place up. After a
delete, refetch the current page rather than only removing the row locally, or the
first row of the next page is skipped. If the current page becomes empty and it is
not page 1, go to the previous page.

---

## 5. UX checklist

- [ ] The delete asks for confirmation, and says it can't be undone (there is no restore).
- [ ] Wording fits the bill kind: "Delete bill" for confirmed bills, "Discard draft" for drafts, "Delete copy" for duplicates.
- [ ] After deleting an original with copies, the list is refetched (the promoted copy appears under its own `id`).
- [ ] The button is disabled while the request runs.
- [ ] No `res.json()` / body parsing on `204`.
- [ ] `404` is treated as success (bill removed locally, lists refreshed).
- [ ] `403` sends the user to the household picker; `401` goes through token refresh.
- [ ] After success, the bills list, drafts list / pending badge, dashboard, spending breakdown and duplicate suggestions are refreshed.
- [ ] Paginated lists refetch the current page after a delete.
- [ ] Offline or `500`: the bill stays visible and the user can retry.

---

## 6. Testing against a local backend

```bash
curl -i -X DELETE "http://localhost:3000/households/$HID/bills/$BILL_ID" \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `HTTP/1.1 204 No Content`. Run it again: `404` with
`"Bill with ID … not found"`.
