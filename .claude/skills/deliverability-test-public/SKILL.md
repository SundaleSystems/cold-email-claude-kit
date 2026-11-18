---
name: deliverability-test-public
description: Compare reply rates, bounce rates, and positive reply rates broken down by inbox type (SMTP / Gmail / Outlook) for an Instantly workspace. Use when you want to know "which inbox type delivers best" or when debugging unexplained deliverability differences across a mixed fleet. Operates via Instantly API only (no database required).
---

# Deliverability Test — Inbox Type Comparison

Compare reply rates, bounce rates, and positive reply rates broken down by inbox type (SMTP, Gmail / G Suite, Outlook / Office365) across your Instantly workspace. Use it to answer "are my Gmail inboxes performing better than my SMTP ones?" or "why is one inbox type bouncing more than the others?"

## Why this exists

Different inbox types have different deliverability characteristics:
- **Gmail / G Suite** — highest trust, fewest bounces, often best reply rates
- **Office365** — good reputation, but stricter spam filtering
- **SMTP** (Zapmail, Maildoso, Mailforge, custom) — varies wildly by provider, often has higher bounces in the first 30 days of domain life

If your campaigns mix inbox types, this skill shows which type is earning its keep.

## What you need

- `INSTANTLY_API_KEY` in env
- Optional: `--days=<N>` lookback (default 7)

## Steps

```bash
# Full workspace, last 7 days
npx tsx scripts/inbox-type-compare.ts

# 14-day lookback
npx tsx scripts/inbox-type-compare.ts --days=14

# Just show today
npx tsx scripts/inbox-type-compare.ts --days=1
```

## Output

```
Inbox Type Comparison — last 7 days

Type              Inboxes    Sent     Replies   Bounces    Reply %   Bounce %
---------------   ------   -------   -------   -------    -------   --------
G Suite               12    3,120       42        12        1.35%      0.38%
Office365             24    6,440       65        28        1.01%      0.43%
SMTP                  44   10,780       55        98        0.51%      0.91%
---------------   ------   -------   -------   -------    -------   --------
TOTAL                 80   20,340      162       138        0.80%      0.68%

Takeaways:
- G Suite has the highest reply rate (1.35%) and lowest bounce rate.
- SMTP reply rate is 60% lower than G Suite — investigate domain reputation.
- SMTP bounce rate is 2x average — run /email-deliverability-audit on SMTP domains.
```

## How it works

1. Pulls all email accounts via `GET /api/v2/accounts` paginated
2. Groups by Instantly `provider_code` (2 = Google → Gmail / G Suite, 3 = Microsoft → Office365 / Outlook, everything else → SMTP)
3. Pulls per-inbox daily stats from `GET /api/v2/accounts/analytics/daily` for the lookback window — account-level analytics already span all campaigns, so no per-campaign loop is needed
4. Aggregates sent/replies/bounces within each type group
5. Prints formatted table

## Common gotchas

- **Reply rate here is RAW, not positive.** For positive reply rate (the more important metric), use `/positive-reply-scoring`.
- **Small inbox counts are noisy.** If you only have 2 Gmail inboxes and 40 SMTP ones, the Gmail numbers aren't statistically meaningful.
- **Inbox type labels can be surprising.** Some providers register as "SMTP" (provider code 1) even when they're technically Gmail-proxied. Trust the provider code Instantly gave them.

## What to do next

**If one inbox type is underperforming:** `/instantly-inbox-manager` to retire the bad ones (tag `retired`, disable warmup). If replacements are needed, `/zapmail-domain-setup-public` to provision new domains on a different provider type.

**If all types are healthy:** back to the weekly rhythm via `/cold-email-weekly-rhythm`.

**Or wait:** small sample sizes (<500 sends per type) are noisy. If your results are inconclusive, run again in 7 days with more data.

## Related skills

- `/email-deliverability-audit` — full audit (SPF/DKIM/DMARC + reputation + spam placement)
- `/positive-reply-scoring` — the metric that matters, not just reply rate
- `/instantly-inbox-manager` — rotate out bad inboxes, tag by performance

## Scripts

- `scripts/inbox-type-compare.ts` — pulls + compares per-type rates
