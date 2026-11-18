---
name: email-deliverability-audit
description: Diagnostic audit for a running cold email program. Checks domain authentication (SPF/DKIM/DMARC), inbox health/reputation from Instantly, bounce rate by inbox, and optionally runs a spam placement test via Instantly's Inbox Placement API. Outputs markdown report + CSV with per-domain/per-inbox scores and concrete action items. Use when reply rates drop, when bounces spike, when onboarding someone else's account, or as a weekly/monthly health check.
---

# Email Deliverability Audit

**If your positive reply rate is dropping and you don't know why, start here.** Most of the time the problem is deliverability — your emails aren't reaching inboxes. This skill tells you what's broken.

## What it checks

| Layer | What | How |
|---|---|---|
| DNS auth | SPF, DKIM, DMARC present on each sending domain | `dig` commands (plus optional Instantly vitals check) |
| Inbox health | Warmup status, warmup score, blocks, connection errors | Instantly accounts API |
| Volume health | Daily sent trending, capacity utilization | Instantly account daily analytics |
| Send + reply rate per inbox | Sent count, reply count, reply rate % over lookback period | Instantly campaign + account analytics |
| Bounce rate | Per-inbox and per-domain bounce rate over last 30 days | Instantly campaign + account analytics |
| Spam placement | Real inbox-vs-spam test via Instantly Inbox Placement | optional |

## The 1% rule — core domain-health threshold

**A healthy domain should have an overall reply rate of at least 1% after 200 emails sent.**

Below 1% after 200+ sends is a red flag — something is broken. The audit explicitly checks this and flags any domain or inbox that:
- Has sent ≥200 emails in the lookback window
- Has an overall reply rate <1%

Possible causes (the audit's "root-cause suggestions" try to pinpoint which):
- Emails landing in spam (run the spam placement test)
- Domain reputation damaged (check DMARC reports, reconsider domain age)
- Copy is broken (manually review for vague CTAs, generic openers, or em dashes; re-run `/spam-word-checker`)
- List is cold / wrong ICP (check bounce rate — if >3%, list is the problem)
- Inbox hasn't warmed enough (check warmup status)

Below 200 sends: too early to judge. The rule needs sample size.

## When to use

- Reply rate dropped by >30% week-over-week → run the full audit
- Bounces spiked above 2% → run auth + spam-placement checks
- Before scaling a campaign (make sure infrastructure is ready)
- Monthly as routine hygiene
- When taking over an Instantly workspace you didn't set up

## Inputs

- `INSTANTLY_API_KEY` (env)
- Optional: scope the audit
  - `--campaign-id=X` (audit only one campaign's inboxes)
  - `--domain=example.com` (audit only one domain)
  - `--tag=active` (audit only inboxes tagged active)

## Steps

### 1. Pull the inbox inventory

```bash
npx tsx scripts/audit-inboxes.ts --all --out=/tmp/audit/inboxes.csv
```

Outputs per inbox: email, domain, from_name, tags, status, is_connected, warmup_status, warmup_reputation (Instantly's `stat_warmup_score`, 0-100), max_warmup_per_day, is_warmup_blocked, message_per_day, daily_sent_count, provider_code.

Account `status` codes: 1 Active, 2 Paused, -1 Connection Error, -2 Soft Ban, -3 Sending Error. `warmup_status`: 1 Active, 0 Paused, negative = blocked/banned.

Add `--vitals` to also run Instantly's DNS vitals check (SPF/DKIM/DMARC/MX per domain, batched server-side) — flagged domains get a `dns_failing` column.

### 2. Check domain authentication

```bash
npx tsx scripts/check-domain-auth.ts --from-csv=/tmp/audit/inboxes.csv --out=/tmp/audit/auth.csv
```

For each unique domain, runs:
```bash
dig TXT <domain> +short          # SPF
dig TXT default._domainkey.<domain> +short    # DKIM (Zapmail uses "default")
dig TXT _dmarc.<domain> +short   # DMARC
```

Outputs: domain, spf_present, spf_strict, dkim_present, dmarc_present, dmarc_policy (none/quarantine/reject).

### 3. Pull sent + reply + bounce metrics per campaign/inbox

```bash
npx tsx scripts/audit-performance.ts --days=30 --out=/tmp/audit/performance
```

Walks all active/paused/completed campaigns, pulls campaign analytics plus per-inbox account daily analytics for the last 30 days. Two outputs: `<out>-campaigns.csv` (authoritative for the 1% rule) and `<out>-inboxes.csv` with columns: `email, domain, sent, replies, bounces, reply_rate_pct, bounce_rate_pct, flag_low_reply, flag_high_bounce`.

Note: per-inbox stats span all campaigns (Instantly has no per-campaign-per-inbox breakdown) — which matches the 1% rule's intent, since inboxes and domains carry reputation across campaigns.

Flagged automatically:
- **`flag_low_reply = TRUE`** if sent ≥200 and reply_rate_pct < 1.0 (the 1% rule)
- **`flag_high_bounce = TRUE`** if sent ≥50 and bounce_rate_pct > 3.0

### 4. (Optional) Run an Inbox Placement spam test

```bash
npx tsx scripts/run-spam-test.ts --campaign-id=<uuid> --senders=100 --out=/tmp/audit/spam-test.json
```

This creates a real inbox-placement test via Instantly's Inbox Placement API:
- Seeds Google + Microsoft ESP pools by default (pass `--all-esps` to seed everything available)
- Sends from up to 100 of your senders using the campaign's step-1 variant-A copy (or `--tag=` / `--emails=` selectors with generic test copy)
- Waits for completion (5-20 min, `--timeout=25` minutes)
- Pulls: placement stats (inbox/spam/category %), per-recipient SPF/DKIM/DMARC pass rates, per-domain SpamAssassin score + triggered rules, blacklist report, deliverability insights

Output shows: what % lands in Inbox vs Spam vs Categories, broken down by your sender and the receiver provider. This is the ground truth.

Note: Inbox Placement tests are plan-gated (workspace `plan_id_inbox_placement`). If the script reports a 402/403, your Instantly plan doesn't include them.

### 5. Synthesize the report

Read the four outputs (`inboxes.csv`, `auth.csv`, `performance-campaigns.csv` + `performance-inboxes.csv`, and optionally `spam-test.json`) and write the markdown report yourself — there is no separate report script.

Produce a markdown report like:

```
# Deliverability Audit — 2026-04-17

## Summary

- 80 inboxes audited across 40 domains
- 3 inboxes blocked (4% of fleet)
- 5 domains missing DKIM
- 2 domains with DMARC policy=none (no enforcement)
- Fleet performance (last 30d):
    Sent:           42,384
    Replies:          523
    Overall reply rate: 1.23% (PASS — above 1% threshold)
    Bounces:           382
    Bounce rate:      0.90% (PASS — below 2%)
- 4 inboxes failed the 1% rule (sent ≥200, reply rate <1%)
- Spam placement (test run): 83% inbox / 14% spam / 3% tabs (ACCEPTABLE but not great)

## Critical issues (fix within 24h)

1. Domain trygrowth.co has no DMARC record. Add: v=DMARC1; p=none; rua=mailto:dmarc@trygrowth.co
2. Inbox sales@trygrowth.co blocked in warmup — likely flagged by warmup network. Rotate out of campaigns.
3. 12 inboxes have 0 daily sent today despite being in active campaigns. Check campaign schedule.
4. Inbox marketing@other.co failed the 1% rule: 347 sent, 1 reply (0.29% reply rate). Investigate:
   - Check spam placement for this inbox
   - Compare copy vs. a sibling inbox that's passing
   - Rotate inbox out if bad reputation is confirmed

## Warnings (fix within 1 week)

- 5 domains missing DKIM record at default._domainkey
- 3 inboxes reputation dropped "fair" → "bad"
- SpamAssassin rule DKIM_INVALID firing 8% of the time — likely for a subset of domains

## Action items (prioritized)

1. [HIGH] Add missing DKIM records to: trygrowth.co, othergrow.co, ...
2. [HIGH] Rotate out blocked inboxes: sales@trygrowth.co, marketing@other.co, ...
3. [MED] Tighten DMARC to p=quarantine on all domains after 2 weeks of p=none observation
4. [MED] Replace 3 bad-reputation inboxes (tag them "retired", provision new)
5. [LOW] Re-run spam placement test after fixing DKIM issues
```

### 6. Act on the action items

Feed the action items into the right skills:
- Missing DKIM / SPF → `/zapmail-domain-setup-public` to reconnect domains through Zapmail
- Blocked inboxes → `/instantly-inbox-manager` to tag "retired" and rotate in insurance
- Campaign schedule issues → Instantly campaign schedule settings
- Bad copy flagged → `/spam-word-checker` on the campaign copy

## Interpreting the numbers

### Bounce rates
- **<1%** — Excellent. Healthy list.
- **1-2%** — Normal for cold. No action.
- **2-3%** — Yellow. Check list quality, might be old emails.
- **>3%** — Red. Verify the list (MillionVerifier), consider pausing.
- **>5%** — Stop immediately. You're damaging domain reputation.

### Spam placement
- **>90% inbox** — Great. Ship more.
- **80-90% inbox** — Acceptable.
- **70-80% inbox** — Yellow. Look at the SpamAssassin rules in the report to see what's triggering.
- **<70% inbox** — Red. Pause and fix auth + copy before sending more.

### DMARC policies
- **None** — Acceptable for first 2 weeks of a domain's life. After that, tighten.
- **Quarantine** — Recommended long-term. Emails that fail auth land in spam.
- **Reject** — Strictest. Only use after 30+ days of clean `rua=` reports confirming all legitimate mail passes.

### Warmup reputation
- Instantly reports the warmup score (`stat_warmup_score`) as 0-100. Higher is better.
- Above 80: inbox is good to send from.
- 50-80: keep warming, don't use for critical sends.
- Below 50: don't send from this inbox — warmup peers aren't seeing it in their inboxes.

## Common root causes

- **SPF too lax** — `v=spf1 +all` whitelists everyone. Use `v=spf1 include:zapmail.com ~all` or similar.
- **DKIM missing** — new domain, selector not published. Zapmail publishes at `default._domainkey` by default.
- **DMARC alignment failure** — From-domain doesn't match SPF/DKIM domain. Usually a misconfigured reply-to or a 3rd-party sender.
- **Too many inboxes per domain** — Gmail flags domains with >3-5 inboxes as suspicious. Keep it at 2/domain.
- **Aggressive warmup ramp** — Jumping from 5 to 40/day in one week = flag. Ramp over 2-4 weeks.
- **Shared sending IP with spam traffic** — Zapmail/most providers use shared pools. If someone else on your IP spammed, you suffer. Not much to do except wait for pool rotation.

## What to do next

**If any flag fired:** `/deliverability-incident-response` → triage decision tree for whatever was flagged (low reply rate, high bounce, blocked inbox, etc).

**If all clean:** next Monday, run this again. This audit is the Monday task in `/cold-email-weekly-rhythm`.

**Or wait:** if you just applied fixes, wait 7 days then re-audit. Reputation changes propagate slowly.

## Related skills

- `/instantly-inbox-manager` — execute the action items (rotate, retag, warmup settings)
- `/zapmail-domain-setup-public` — fix DNS/auth issues at the domain provider
- `/spam-word-checker` — check copy for spam-triggering phrases
- `/deliverability-test-public` — lighter-weight SMTP vs Gmail vs Outlook reply/bounce comparison

## Scripts

- `scripts/audit-inboxes.ts` — pull + format inbox inventory (with optional DNS vitals)
- `scripts/check-domain-auth.ts` — dig-based SPF/DKIM/DMARC checks
- `scripts/audit-performance.ts` — per-campaign and per-inbox sent / replies / bounces / rates from analytics (applies the 1% rule)
- `scripts/run-spam-test.ts` — create + poll + pull an Inbox Placement test

## References

- `/instantly-api` skill — full Instantly API v2 endpoint reference (auth, pagination, Inbox Placement endpoints)
- `references/dns-records.md` — SPF/DKIM/DMARC record templates + interpretation guide
