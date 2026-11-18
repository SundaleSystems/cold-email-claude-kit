---
name: instantly-api
description: Instantly.ai API v2 endpoint reference and patterns. Use for any Instantly campaign, lead, email account, analytics, warmup, tag, Unibox, or inbox placement operation. Covers auth, rate limiting, pagination, and all commonly used endpoints.
user_invocable: false
---

# Instantly API v2 Reference

## Authentication

All requests use a **Bearer token header** — never query-param auth:

```
Authorization: Bearer {INSTANTLY_API_KEY}
Content-Type: application/json
```

The header must be exactly `Authorization: Bearer {key}` (capital B). A 401 means the header format is wrong or you're using a deprecated v1 key — v2 requires a new key generated in Instantly under Settings → Integrations → API Keys. Keys are workspace-scoped and support granular scopes (e.g. `campaigns:read`, `accounts:update`).

Environment variable: `$INSTANTLY_API_KEY`

Base URL: `https://api.instantly.ai` (all paths below are under `/api/v2/...`)

**Credential check:** `GET /api/v2/workspaces/current` → 200 with `{ name, ... }` confirms the key works.

**Authoritative payload shapes:** the full OpenAPI spec is public at `https://api.instantly.ai/openapi/api_v2.json`. When a field name is in doubt, check the spec — do not guess.

## Rate Limiting

- Most endpoints: generous limits; retry on 429 + 5xx with exponential backoff (`1000 * 2**attempt` ms, 4-5 attempts).
- **`GET /api/v2/emails`: 20 requests/minute** — always throttle (≥3s between calls) and use `limit=100`.
- `POST /api/v2/emails/test`: 10 requests/minute.
- `POST /api/v2/lead-labels/ai-reply-label`: 500 requests per 30 days.
- Bulk work: use a small concurrency pool (5-8 workers), not unbounded `Promise.all`.

## Pagination

List endpoints return `{ items: [...], next_starting_after: "..." }`. Pass `?limit=100&starting_after={next_starting_after}` to get the next page; stop when `next_starting_after` is absent or `items` is empty. (This replaces offset/limit pagination.)

## Campaigns

| Operation | Endpoint |
|---|---|
| Create campaign | `POST /api/v2/campaigns` |
| Get / update / delete | `GET`/`PATCH`/`DELETE /api/v2/campaigns/{id}` |
| List campaigns | `GET /api/v2/campaigns?limit=&starting_after=&status=` |
| Activate (start/resume) | `POST /api/v2/campaigns/{id}/activate` |
| Pause | `POST /api/v2/campaigns/{id}/pause` |
| Why isn't it sending? | `GET /api/v2/campaigns/{id}/sending-status` |
| Add campaign variables | `POST /api/v2/campaigns/{id}/variables` |

Campaign creation is a **single call** — sequences, sending accounts, schedule, and settings all go in one payload (no separate sequences/settings/schedule endpoints like other platforms):

```json
{
  "name": "My Campaign",
  "email_list": ["inbox1@domain.com", "inbox2@domain.com"],
  "daily_limit": 30,
  "daily_max_leads": 100,
  "stop_on_reply": true,
  "open_tracking": false,
  "link_tracking": false,
  "stop_on_auto_reply": false,
  "campaign_schedule": {
    "schedules": [{
      "name": "Weekdays",
      "timing": { "from": "09:00", "to": "17:00" },
      "days": { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false },
      "timezone": "America/New_York"
    }]
  },
  "sequences": [{
    "steps": [
      { "type": "email", "delay": 3, "variants": [
        { "subject": "Quick question", "body": "Hey {{first_name}}, ..." },
        { "subject": "Quick question", "body": "Variant B body..." }
      ]},
      { "type": "email", "delay": 4, "variants": [{ "subject": "", "body": "Follow-up..." }] }
    ]
  }]
}
```

Key conventions:
- `days` keys are `"0"` (Sunday) through `"6"` (Saturday) — **0=Sunday**, not 1=Monday.
- `delay` on a step = days to wait before the NEXT email (`delay_unit` defaults to `days`).
- A/B/C testing = multiple entries in a step's `variants` array (`{subject, body, v_disabled?}`). Instantly splits sends across enabled variants; step analytics report `variant` 0=A, 1=B, 2=C.
- **Empty subject `""` on a follow-up step = threads as a reply** to the previous email.
- `email_list` assigns sending accounts by their email addresses (not numeric IDs).
- Campaigns are **created in Draft** (status 0). They send nothing until `/activate` is called or the user launches in the UI.

Campaign `status` codes: `0` Draft, `1` Active, `2` Paused, `3` Completed, `4` Running Subsequences, `-99` Account Suspended, `-1` Accounts Unhealthy, `-2` Bounce Protect.

## Leads

| Operation | Endpoint |
|---|---|
| **Bulk add to campaign/list** | `POST /api/v2/leads/add` — **max 1000 leads per request** |
| Create single lead | `POST /api/v2/leads` |
| List/filter leads | `POST /api/v2/leads/list` (POST, not GET — body has `campaign`, `search`, `limit`, `starting_after`) |
| Get / update / delete | `GET`/`PATCH`/`DELETE /api/v2/leads/{id}` |
| Update interest status | `POST /api/v2/leads/update-interest-status` |

Bulk add payload:

```json
{
  "campaign_id": "uuid",
  "skip_if_in_campaign": true,
  "leads": [{
    "email": "jane@acme.com",
    "first_name": "Jane",
    "last_name": "Doe",
    "company_name": "Acme",
    "custom_variables": { "title": "CEO", "situation_line": "..." }
  }]
}
```

- Personalization fields go in **`custom_variables`** (an object of key→string/number/boolean). Keys become `{{merge_tags}}` in copy — the key must match exactly (case-sensitive).
- Response reports `leads_uploaded`, `duplicated_leads`, `invalid_email_count`, `skipped_count`, `in_blocklist`.
- Dedupe flags: `skip_if_in_campaign` / `skip_if_in_list` / `skip_if_in_workspace`.
- Lead fields with built-in merge tags: `first_name`, `last_name`, `company_name`, `job_title`, `website`, `phone`, `personalization`.

## Email Accounts (inboxes)

| Operation | Endpoint |
|---|---|
| List accounts | `GET /api/v2/accounts?limit=100&starting_after=&include_tags=true` |
| Get / update / delete | `GET`/`PATCH`/`DELETE /api/v2/accounts/{email}` (keyed by **email address**, not numeric id) |
| Pause / resume | `POST /api/v2/accounts/{email}/pause` / `/resume` |
| Enable warmup (bulk) | `POST /api/v2/accounts/warmup/enable` `{ "emails": [...] }` → background job |
| Disable warmup (bulk) | `POST /api/v2/accounts/warmup/disable` `{ "emails": [...] }` → background job |
| Warmup analytics | `POST /api/v2/accounts/warmup-analytics` `{ "emails": [...] }` |
| DNS vitals (MX/SPF/DKIM/DMARC) | `POST /api/v2/accounts/test/vitals` `{ "accounts": [...] }` |
| Per-account daily send stats | `GET /api/v2/accounts/analytics/daily?start_date=&end_date=` |

Account object fields to know:
- `status`: `1` Active, `2` Paused, `-1` Connection Error, `-2` Soft Ban, `-3` Sending Error.
- `warmup_status`: `0` Paused, `1` Active, `-1` Banned, `-2` Spam Folder Unknown, `-3` Permanent Suspension.
- `stat_warmup_score`: 0–100 warmup health score (also `health_score` per email in warmup-analytics `aggregate_data`, with `landed_inbox` / `landed_spam` counts).
- `warmup` settings object (set via `PATCH /api/v2/accounts/{email}`): `{ limit, increment ("disabled"|"0".."4" — slow-ramp daily increment), reply_rate }`.
- `daily_limit`: campaign sending limit per day. `signature`: HTML signature string. `provider_code`: `1` custom IMAP/SMTP, `2` Google, `3` Microsoft, `4`/`8` other.
- Filters: `?status=`, `?provider_code=`, `?tag_ids=`, `?search=`; warmup state filters like `ACC_FILTER_W_ACTIVE`.

## Tags

Tags are first-class **custom tag** objects assigned to accounts or campaigns (no per-account tag list to replace):

| Operation | Endpoint |
|---|---|
| Create tag | `POST /api/v2/custom-tags` `{ "label": "active" }` |
| List tags | `GET /api/v2/custom-tags?search=` |
| Assign/unassign | `POST /api/v2/custom-tags/toggle-resource` `{ "tag_ids": ["..."], "resource_type": 2, "resource_ids": ["inbox@d.com"], "assign": true }` |
| List assignments | `GET /api/v2/custom-tag-mappings?resource_ids=` |

`resource_type`: `1` = campaigns, `2` = accounts. To remove a tag, same call with `"assign": false` — no read-modify-write needed.

## Unibox (replies / emails)

| Operation | Endpoint |
|---|---|
| List emails | `GET /api/v2/emails?campaign_id=&email_type=received&limit=100&starting_after=` — **20 req/min** |
| Get / update / delete | `GET`/`PATCH`/`DELETE /api/v2/emails/{id}` |
| Reply to a thread | `POST /api/v2/emails/reply` (needs `reply_to_uuid`) |
| Unread count | `GET /api/v2/emails/unread/count` |

Email object: `body.text` / `body.html`, `subject`, `lead` (lead email), `lead_id`, `campaign_id`, `step`, `eaccount` (sending account), `thread_id`, `timestamp_email`, `is_auto_reply` (1 = auto-reply/OOO), `ue_type`. Filter replies with `email_type=received`; use `min_timestamp_created` for incremental pulls.

Native reply categorization exists (lead labels + `POST /api/v2/lead-labels/ai-reply-label`, 500/30d) — useful for spot checks, but skills in this repo run their own Claude classification.

## Analytics

| Operation | Endpoint |
|---|---|
| Campaign totals | `GET /api/v2/campaigns/analytics?id={campaign_id}&start_date=&end_date=` |
| All-campaign overview | `GET /api/v2/campaigns/analytics/overview` |
| Daily time series | `GET /api/v2/campaigns/analytics/daily?campaign_id=` |
| Per-step / per-variant | `GET /api/v2/campaigns/analytics/steps?campaign_id=` |
| Per-account daily | `GET /api/v2/accounts/analytics/daily` |

Campaign analytics fields: `emails_sent_count`, `reply_count`, `reply_count_unique` (excludes auto-replies), `reply_count_automatic`, `bounced_count`, `unsubscribed_count`, `open_count`, `link_click_count`, `leads_count`, `contacted_count`, `completed_count`. Daily rows: `sent`, `replies`, `unique_replies`, `opened`, `clicks`. Account daily rows include `bounced` per inbox per day.

## Inbox Placement (spam testing)

Instantly's built-in deliverability test suite (equivalent of third-party seed-list spam tests):

| Operation | Endpoint |
|---|---|
| Create test | `POST /api/v2/inbox-placement-tests` |
| Get / list tests | `GET /api/v2/inbox-placement-tests[/{id}]` |
| Seed ESP options | `GET /api/v2/inbox-placement-tests/email-service-provider-options` |
| Placement stats | `POST /api/v2/inbox-placement-analytics/stats-by-test-id` `{ "test_ids": [...] }` → `inbox_percent` / `spam_percent` / `category_percent` |
| Per-recipient detail | `GET /api/v2/inbox-placement-analytics?test_id=` (SPF/DKIM/DMARC pass per received email) |
| Insights | `POST /api/v2/inbox-placement-analytics/deliverability-insights` |
| Blacklist + SpamAssassin | `GET /api/v2/inbox-placement-reports?test_id=` → per-domain `spam_assassin_score`, `spam_assassin_report`, `blacklist_report` |

Create-test essentials: `name`, `type` (`1` one-time, `2` automated/recurring), `sending_method` (`1` sent from Instantly accounts), `emails` (sender account addresses), `email_subject`, `email_body`, `recipients_labels` (pick from ESP options), `run_immediately: true`. Test `status`: `1`/`2`/`3` (poll until complete). Plan gating: `plan_id_inbox_placement` on the workspace — placement tests require a plan that includes them.

## Background Jobs

Bulk operations (warmup enable/disable, lead imports/moves) return a background job: `{ id, status: pending|in-progress|success|failed, progress }`. Poll `GET /api/v2/background-jobs/{id}` every few seconds until `success`/`failed`.

## TypeScript Fetch Pattern

```typescript
const API = "https://api.instantly.ai";
const KEY = process.env.INSTANTLY_API_KEY!;

async function instantlyFetch(path: string, init: RequestInit = {}, attempts = 4): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
  }
}

// Paginate any list endpoint
async function listAll(path: string): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  const out: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await instantlyFetch(`${path}${sep}limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
    const items = page.items ?? page.data ?? [];
    out.push(...items);
    if (!page.next_starting_after || items.length === 0) break;
    cursor = page.next_starting_after;
  }
  return out;
}
```

## Caching Tip

Account lists change rarely. For scripts that run repeatedly, cache `GET /api/v2/accounts` results to a local JSON file and refresh hourly rather than re-pulling hundreds of accounts every run.

## Consumer Skills

Return to the skill that sent you here. Skills that build on this reference:

- `/instantly-inbox-manager` — warmup, signatures, tags, health dashboard
- `/instantly-campaign-upload-public` — variants.yaml + leads.csv → Draft campaign
- `/email-deliverability-audit` — inbox health, performance, inbox placement tests
- `/positive-reply-scoring` — reply pulls + classification
- `/deliverability-incident-response` — triage playbook
