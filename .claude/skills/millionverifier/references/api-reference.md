# MillionVerifier API Reference

Extracted from the official OpenAPI spec embedded at https://developer.millionverifier.com (2026-07-22).

## Basics

- **Single API base:** `https://api.millionverifier.com`
- **Bulk API base:** `https://bulkapi.millionverifier.com`
- **Auth:** API key as a query parameter — `api=` on the Single API, `key=` on the Bulk API. Get yours at https://app.millionverifier.com/api
- **Test key:** `API_KEY_FOR_TEST` — returns **random** results (`livemode: false`), free, for development only. Works on the **Single API only**; the Bulk API rejects it with `{"error": "invalid_api_key"}` (verified empirically 2026-07-22, despite the docs implying otherwise).
- **Credits:** 1 credit per unique email. Bulk uploads report their exact cost (`credit` field) before verification runs.

---

## Single API

### GET `/api/v3` — verify one email in real time

| Param | Required | Notes |
|---|---|---|
| `api` | yes | API key |
| `email` | yes | Email to verify |
| `timeout` | no | Seconds before giving up on the recipient server, 2–60 (default 20) |

```
GET https://api.millionverifier.com/api/v3/?api=your-api-key&email=jane@acme.com&timeout=10
```

Response:

```json
{
  "email": "bademail@gmal.com",
  "quality": "good",            // "" | good | bad | risky
  "result": "invalid",          // ok | catch_all | unknown | error | disposable | invalid
  "resultcode": 6,              // 1=ok 2=catch_all 3=unknown 4=error 5=disposable 6=invalid
  "subresult": "bad_domain",
  "free": false,                // Gmail/Yahoo-style free provider
  "role": false,                // admin@/sales@-style role address
  "didyoumean": "bademail@gmail.com",  // typo suggestion, usually ""
  "credits": 3454,              // remaining balance
  "executiontime": 2,           // ms
  "error": "",                  // e.g. "apikey_not_found" when result=error
  "livemode": true              // false when using the test key
}
```

`result=error` (code 4) means the *request* failed (bad key, malformed email), not that the address is bad — check the `error` field.

### GET `/api/v3/credits` — balance

```
GET https://api.millionverifier.com/api/v3/credits?api=your-api-key
```

```json
{ "credits": 24500, "bulk_credits": 24500, "renewing_credits": 10000, "plan": 3 }
```

`bulk_credits` is the same pool as `credits` — there is one balance shared by both APIs.

---

## Bulk API

Lifecycle: **upload → poll fileinfo → download → (optionally delete)**.

### POST `/bulkapi/v2/upload` — upload a file

- Query param: `key` (required)
- Body: `multipart/form-data` with the file in field **`file_contents`**
- File format: CSV or TXT containing email addresses (one per line is simplest; MV extracts and dedupes emails)

```bash
curl -F "file_contents=@emails.txt" "https://bulkapi.millionverifier.com/bulkapi/v2/upload?key=your-api-key"
```

Success response (same shape as `fileinfo`):

```json
{
  "file_id": "940",
  "file_name": "mails500.txt",
  "status": "in_progress",
  "unique_emails": 257,
  "updated_at": "2021-05-16 12:25:42",
  "createdate": "2021-05-16 12:25:42",
  "percent": 60,
  "total_rows": 500,
  "verified": 0,
  "unverified": 0,
  "ok": 0,
  "catch_all": 0,
  "disposable": 0,
  "invalid": 0,
  "unknown": 0,
  "reverify": 0,
  "credit": 0,               // credits this file will consume
  "estimated_time_sec": 120,
  "error": ""
}
```

Failure response:

```json
{ "error": "insufficient_credits", "unique_emails": 250000, "credits": 500 }
```

### GET `/bulkapi/v2/fileinfo` — poll progress

| Param | Required |
|---|---|
| `key` | yes |
| `file_id` | yes |

Returns the same shape as upload. Poll until `status` is terminal.

`status` values: `in_queue_to_start`, `in_progress`, `finished`, `paused`, `canceled`, `error`.

While running, `percent` and the per-status counters (`ok`, `catch_all`, `disposable`, `invalid`, `unknown`) update live.

### GET `/bulkapi/v2/download` — download the result report

| Param | Required | Values |
|---|---|---|
| `key` | yes | |
| `file_id` | yes | |
| `filter` | **yes** | `ok` \| `ok_and_catch_all` \| `unknown` \| `invalid` \| `all` \| `custom` |
| `statuses` | with `filter=custom` | comma-separated: `ok,catch_all,unknown,invalid,disposable` (omitted = all) |
| `free` | with `filter=custom` | `1` = only free-provider emails, `0` = only non-free (omitted = both) |
| `role` | with `filter=custom` | `1` = only role emails, `0` = only non-role (omitted = both) |

Returns the report as a CSV file (`application/octet-stream`); on failure returns JSON `{ "error": "..." }` — check the first byte before parsing as CSV.

```
GET https://bulkapi.millionverifier.com/bulkapi/v2/download?key=your-api-key&file_id=940&filter=all
```

### GET `/bulkapi/v2/filelist` — list uploaded files

| Param | Notes |
|---|---|
| `key` | required |
| `offset`, `limit` | pagination; `limit` max/default 50 |
| `id` | comma-separated file IDs (`id=1,2,3`) |
| `name` | substring match on file name |
| `status` | comma-separated from the status values above |
| `updated_at_from` / `updated_at_to` | datetime filters |
| `createdate_from` / `createdate_to` | datetime filters |
| `percent_from` / `percent_to` | progress range |
| `has_error` | boolean-ish: `1/0/true/false/t/f` |

Response: `{ "files": [...], "total": 123 }`

### GET `/bulkapi/stop` — cancel a file in progress

⚠️ **No `/v2/` in this path** — it's `/bulkapi/stop`, unlike every other bulk endpoint.

Params: `key`, `file_id`. Results for already-verified emails become downloadable a few seconds after stopping.

Response: `{ "result": "ok" }` or `{ "error": "file_not_found" }`

### GET `/bulkapi/v2/delete` — delete a file from MV

Params: `key`, `file_id`. Removes the file and its report from MillionVerifier (no re-download afterward).

Response: `{ "result": "ok" }` or `{ "error": "file_not_found" }`

---

## Error shapes worth handling

| Where | Shape | Meaning |
|---|---|---|
| Single API | `result: "error"`, `error: "apikey_not_found"` | Bad/missing API key |
| Bulk upload | `{ "error": "insufficient_credits", "unique_emails": N, "credits": M }` | Need N credits, have M |
| Bulk stop/delete/download | `{ "error": "file_not_found" }` | Wrong `file_id` or already deleted |
| Any | HTTP 429 / 5xx | Back off exponentially and retry |

## Status → cold email decision

| Status | Send? |
|---|---|
| `ok` | Yes |
| `catch_all` | Optional — domain accepts all mail, mailbox unconfirmed; adds bounce risk |
| `unknown` | No — re-verify later |
| `invalid` | Never — guaranteed bounce |
| `disposable` | Never — burner address |
