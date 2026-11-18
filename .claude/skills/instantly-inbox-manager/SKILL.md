---
name: instantly-inbox-manager
description: Programmatic inbox management for Instantly.ai. Enable/disable warmup with correct ramp settings, set signatures in bulk, tag inboxes (active vs insurance), and pull inbox health dashboards. Use after creating a new batch of inboxes via /zapmail-domain-setup-public, or when managing an existing Instantly workspace at scale. Triggers on "turn on warmup", "set signatures", "tag inboxes", "inbox health", "set up new inboxes".
---

# Instantly Inbox Manager

Zapmail hands you hundreds of new inboxes. Instantly needs them configured: warmup enabled with the right ramp, signatures set so emails don't look bare, tags applied so you know which are active vs insurance, and health monitored so dead inboxes get recycled.

This skill does all of that via the Instantly API v2.

## Core operations

| Operation | What it does | Script |
|---|---|---|
| Enable warmup | Turns on warmup with correct ramp (slow ramp up to 40/day) | `set-warmup.ts --mode=enable` |
| Disable warmup | Turns off warmup (use for active inboxes) | `set-warmup.ts --mode=disable` |
| Set signatures | Bulk-applies a signature template to inboxes | `set-signatures.ts` |
| Tag as active | Adds the "active" tag | `tag-inboxes.ts --add=active` |
| Tag as insurance | Adds the "insurance" tag | `tag-inboxes.ts --add=insurance` |
| Health dashboard | Lists all inboxes with warmup status, warmup score, limits | `list-health.ts` |

## Active vs insurance (the tagging convention)

Not every inbox should send all the time. A common pattern:

- **Active inboxes** — currently sending in live campaigns. Warmup OFF (or minimal) to prioritize real sends.
- **Insurance inboxes** — warmed but idle, held in reserve. Warmup ON to maintain reputation. Swap in when an active inbox burns out.

Tags are how you track this at scale. Filter by tag in the Instantly UI or via API (`?tag_ids=` on `GET /api/v2/accounts`).

## Inputs

Every script reads:
- `INSTANTLY_API_KEY` (env var)
- Inbox selector: `--emails=a@x.com,b@y.com` OR `--domain=example.com` OR `--tag=insurance` OR `--all`
  - Instantly accounts are keyed by **email address**, not numeric id. `--ids=` still works as a backward-compat alias (values are emails).
  - `--ids-from-csv=path` expects an `email` header column (a legacy `id` column also works — values are treated as emails).
- Operation-specific flags (see each script)

## Warmup ramp settings

Default warmup config for a NEW inbox (week 1-4 of warmup period), applied via `PATCH /api/v2/accounts/{email}` after the bulk `POST /api/v2/accounts/warmup/enable` call:

```json
{
  "warmup": {
    "limit": 40,
    "increment": "4",
    "reply_rate": 20
  }
}
```

- `limit`: max emails/day the inbox sends in the warmup network (peak)
- `increment`: daily slow-ramp added to the warmup volume until `limit` is reached. It's a **string enum**: `"disabled"` or `"0"`–`"4"` — `"4"` is the fastest ramp Instantly supports
- `reply_rate`: how often warmup peers reply (20 is realistic)

For INSURANCE inboxes (maintaining reputation long-term):
```json
{
  "warmup": {
    "limit": 15,
    "increment": "disabled",
    "reply_rate": 20
  }
}
```

Lower volume, no ramp — just keeps the inbox warm.

For ACTIVE inboxes (currently in live campaigns): disable warmup entirely with one bulk call:

```
POST /api/v2/accounts/warmup/disable  { "emails": ["a@x.com", ...] }
```

Warmup off so the daily send budget goes to real prospects. Both bulk warmup calls return a **background job** — the script polls `GET /api/v2/background-jobs/{id}` until it completes.

## Signature template

The default template, applied in bulk via `set-signatures.ts`, is:

```
{from_name}
{title}
{company}
{address}
```

Rendered (for example):
```
Jane Smith
Founder
Acme
123 Main St, Suite 400, Austin, TX 78701
```

**Where each value comes from:**
- `{from_name}` — the account's own `first_name` + `last_name` if set (different personas per inbox), else `SENDER_FIRST_NAME + SENDER_LAST_NAME` from `.env`
- `{title}` — `SENDER_TITLE` env var
- `{company}` — `SENDER_COMPANY_NAME` env var
- `{address}` — `SENDER_PHYSICAL_ADDRESS` env var (recommended — a real mailing address in the footer keeps you on the right side of CAN-SPAM and similar rules)

**Required `.env` entries for the default template:**
```
SENDER_FIRST_NAME=Jane
SENDER_LAST_NAME=Smith
SENDER_TITLE=Founder
SENDER_COMPANY_NAME=Acme
SENDER_PHYSICAL_ADDRESS=123 Main St, Suite 400, Austin, TX 78701
```

**Custom template override:**
```bash
# Pass inline (use \n for newlines)
npx tsx scripts/set-signatures.ts --all --template="Cheers,\n{from_name}\n{title}\n{company}\n{address}"

# Or from a file
npx tsx scripts/set-signatures.ts --all --template-file=./my-signature.txt
```

Available placeholders: `{from_name}`, `{from_email}`, `{domain}`, `{title}`, `{company}`, `{address}`.

**How signatures reach the email body:**

Instantly's account `signature` field is HTML — the script converts template newlines to `<br>` tags before uploading. **Instantly appends the account signature automatically** to campaign emails; set it once per account here and don't paste signatures into sequence bodies. That way every inbox sends with a real name + title + company + mailing address in the footer.

## Health dashboard output

`list-health.ts` prints a CSV + summary. CSV columns: `email,domain,tags,warmup,warmup_score,warmup_limit,daily_limit,status,setup_pending,health_status` (pass `--deep` to add `landed_inbox,landed_spam,health_score` from warmup analytics):

```
email                              warmup   warmup_score   daily_limit   health_status
john@example.co                    on       92             30            healthy
jane@example.co                    on       61             30            warming
sales@other.co                     off      88             30            healthy
support@other.co                   on       12             30            blocked
```

Summary:
```
Total inboxes: 80
  Warmup on: 50
  Active (warmup off): 28
  Blocked/failed: 2

Warmup score (stat_warmup_score):
  Good (>=80): 65
  Fair (>=50): 10
  Bad (<50): 3
  Unknown: 2

Action items:
  - 2 inboxes blocked — run /email-deliverability-audit
  - 3 inboxes with bad warmup score — consider pausing
```

## Common workflows

### Day 1 after Zapmail provisioning

```bash
# 1. Enable warmup on all newly created inboxes
npx tsx scripts/set-warmup.ts --mode=enable --tag=new --warmup-per-day=40 --ramp=4

# 2. Set signatures
npx tsx scripts/set-signatures.ts --tag=new --template="Best,\n{from_name}"

# 3. Tag them as insurance (they aren't active yet — warmup for 2 weeks first)
npx tsx scripts/tag-inboxes.ts --tag=new --add=insurance
npx tsx scripts/tag-inboxes.ts --tag=new --remove=new
```

### Activating insurance inboxes into a live campaign

```bash
# 1. Identify warm insurance inboxes with good warmup score
npx tsx scripts/list-health.ts --tag=insurance --filter=reputation:good --out=activate-candidates.csv

# 2. Flip them to active
npx tsx scripts/tag-inboxes.ts --ids-from-csv=activate-candidates.csv --add=active --remove=insurance

# 3. Disable warmup (they're sending for real now)
npx tsx scripts/set-warmup.ts --mode=disable --tag=active
```

### Weekly health check

```bash
npx tsx scripts/list-health.ts --all --deep --out=health-$(date +%Y-%m-%d).csv
```

Review the action items. Replace blocked inboxes.

## The 1% rule — when to retire an inbox

**A healthy inbox should have an overall reply rate of ≥1% after sending 200+ emails.** Below that, it's likely burned or has poor deliverability.

To identify inboxes failing this rule:

```bash
# Run the audit to find offenders
/email-deliverability-audit → scripts/audit-performance.ts --days=30 --out=/tmp/audit/performance.csv

# Then tag the failing inboxes as retired
echo "email" > /tmp/retire-emails.csv
cat /tmp/audit/performance.csv | awk -F',' '$11 == "\"true\"" { print $1 }' >> /tmp/retire-emails.csv
npx tsx scripts/tag-inboxes.ts --ids-from-csv=/tmp/retire-emails.csv --add=retired --remove=active
npx tsx scripts/set-warmup.ts --mode=disable --tag=retired
```

## Common gotchas

- **Warmup on/off is bulk, settings are per-account.** `POST /accounts/warmup/enable|disable` flips many inboxes in one call (background job), but `limit`/`increment`/`reply_rate` are set per-account via `PATCH /accounts/{email}`. The scripts handle both steps.
- **Background jobs.** Bulk warmup calls return a job; the scripts poll `GET /api/v2/background-jobs/{id}` every 3s (~2min timeout, then they print the job id so you can check later).
- **Rate-limiting.** Instantly retries on 429/5xx with backoff. The scripts use 5 concurrent by default. Don't crank this higher without testing.
- **Warmup blocked.** A negative `warmup_status` means trouble: `-1` Banned, `-2` Spam Folder Unknown, `-3` Permanent Suspension. Manual investigation needed.
- **Tags are first-class objects.** Create once (`POST /custom-tags`), then assign/unassign across many accounts with a single `POST /custom-tags/toggle-resource` call (`assign: true|false`). No read-modify-write of per-inbox tag lists.
- **Signature is HTML.** Instantly stores the signature as HTML. The script converts newlines to `<br>`. Keep it minimal — heavy HTML can break rendering across Gmail/Outlook/Apple Mail. Test after setting.
- **Warmup ramp accumulates.** With `increment: "4"`, warmup volume starts near 0 and adds 4/day until it hits `limit`. To reset (e.g. after a break), disable then re-enable.

## What to do next

**If you just provisioned new inboxes:** enable warmup (`set-warmup.ts --mode=enable`), apply signatures (`set-signatures.ts`), tag as `insurance`, then **wait 2 weeks for warmup**. After 2 weeks, promote `insurance` → `active`.

**If inboxes are already warm:** proceed to list-building (`/vayne-lead-pipeline`, `/disco-like`, etc.) using `active`-tagged inboxes.

**Or wait:** if health dashboard shows bad-warmup-score inboxes, retire them first (tag `retired`, disable warmup) before launching a new campaign.

## Related skills

- `/zapmail-domain-setup-public` — creates the inboxes this skill configures
- `/email-deliverability-audit` — when health dashboard shows problems
- `/instantly-api` — underlying API reference
- `/instantly-campaign-upload-public` — assign `active` inboxes to a campaign

## Scripts

- `scripts/set-warmup.ts` — enable/disable warmup, configure ramp
- `scripts/set-signatures.ts` — bulk signature setting
- `scripts/tag-inboxes.ts` — add/remove tags
- `scripts/list-health.ts` — health dashboard CSV + summary
- `scripts/_lib.ts` — shared: API client, inbox selector parser, tag resolution, job polling, concurrency
