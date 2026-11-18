---
name: account-manager
description: The accountable account manager for a cold-email client. Checks the Instantly account every day, keeps a campaign running, keeps sends at or above the client's daily floor by raising limits, adding leads, or creating a campaign, and escalates only what a human must decide. Use when the user says "run the account manager", "daily check", "are we sending", "why are we under 1,500", "follow-up on the escalation", "add a list to the runbook", or when the headless daily run hands off a NEED_LEADS / RESUME_CANDIDATE escalation.
---

# Account Manager

One client = one folder in `account-manager/clients/<client>/`:

| File | What it is |
|---|---|
| `runbook.json` | Targets (daily send floor, runway, bounce ceiling), autonomy switches (what the agent may do alone), inbox pool rules, approved lead stock |
| `ops-log.md` | Append-only log of every run: what it did, what it escalated |
| `state/<date>.json`, `state/latest.json` | Full snapshot per run (campaign views, actions, escalations). Bounce guard diffs these |
| `requests/needs-leads.json` | Written when runway is short; the follow-up mode reads it |

The deterministic brain is `account-manager/scripts/daily.ts`. It runs every morning from launchd (`account-manager/install-launchd.sh`) and posts to Slack. **Never duplicate its logic in prose; run it.**

## Mode 1 — `daily` (default)

```bash
npx tsx account-manager/scripts/daily.ts --client=<client>            # real run (acts + Slack + log)
npx tsx account-manager/scripts/daily.ts --client=<client> --dry      # show what it would do
```

Rules it applies, in order:

1. **Inbox health.** Unhealthy = status≠active, warmup≠active, or warmup score < `min_warmup_score`. >10% of fleet → `INBOX_HEALTH` escalation.
2. **Bounce guard.** Any active campaign over `max_bounce_rate_7d` on ≥100 sends in the last 7 days is paused → `BOUNCE`.
3. **Paused campaigns with ≥200 fresh leads.** If the id is in `resume_allowlist`, attach the healthy inbox pool and resume when volume is short. Otherwise → `RESUME_CANDIDATE` (the user decides; the agent never resumes something the user paused).
4. **A campaign must be running.** If nothing is live, resume the paused campaign with the most fresh leads; if none, build one from approved stock.
5. **Volume floor.** If sends on the last send day < `min_emails_per_day` or today's capacity is below it: raise campaign daily limits (bounded by the inbox pool and `max_daily_limit_step`), then top up from approved stock: join an existing live campaign cloned from the same copy, or clone `copy_source_campaign_id` into a new campaign on the healthy pool and activate it.
6. **Runway.** Fresh leads ÷ (`min_emails_per_day` ÷ `avg_touches_per_lead`) < `min_runway_days` → `NEED_LEADS`, with every blocked stock item and what unblocks it.
7. **Zombies.** Active campaigns with no inboxes or no leads are paused.

Uploads always use `skip_if_in_workspace`, probe with one lead first (plan lead-cap 403 → `PLAN_LEAD_LIMIT`), and delete a freshly cloned campaign that received 0 new leads.

## Mode 2 — `follow-up` (after an escalation)

Read `state/latest.json` and `requests/needs-leads.json`. For each escalation:

- **NEED_LEADS** — work the blocked stock in this order, cheapest first, and never spend Vayne/LeadMagic credits without a quoted cost and a yes from the user (`autonomy.may_spend_on_lead_sourcing` is the standing answer; `false` means ask):
  1. `needs_verification` → `/millionverifier` on the file, write the ok-only CSV to `Lead-Lists/3-Million-Verifier/`, point `path` at it, set `status: approved`.
  2. `needs_copy` → `/campaign-copywriting` from the client profile, `/spam-word-checker`, `/instantly-spintax`, then `/instantly-campaign-upload-public` as DRAFT with the list; set `copy_source_campaign_id` to the new draft, `status: approved`. Tell the user it is a draft the daily run will activate tomorrow if `may_activate_campaigns` is true.
  3. `needs_personalization` → `/personalization-subagent-pattern` to fill the custom variables, write the enriched CSV, then as in 2.
  4. Nothing left → propose a `/vayne-lead-pipeline` build with the ICP from the profile and the Vayne cost estimate. Ask.
- **RESUME_CANDIDATE** — summarise the campaign (copy, list age, past bounce/reply rates) and ask whether to add it to `resume_allowlist`.
- **BOUNCE / INBOX_HEALTH** — run `/deliverability-incident-response`.
- **PLAN_LEAD_LIMIT** — list completed campaigns older than 60 days with lead counts; propose deleting their leads. Do not delete without a yes.

Finish by appending a `- FOLLOW-UP:` line to `ops-log.md` and re-running `daily.ts --dry` to confirm the next run will be green.

## Mode 3 — `status`

Print `state/latest.json` as a short table (sent vs target, live campaigns, runway, open escalations) and the last 5 ops-log entries. No API calls.

## Adding lead stock

Append to `lead_stock` in the runbook:

```json
{ "id": "slug", "path": "Lead-Lists/4-Final-Lead-Lists/x.csv", "status": "approved",
  "verified": "millionverifier ok (date)", "copy_source_campaign_id": "<campaign whose sequence to clone>",
  "campaign_name": "Name for the new campaign", "column_map": { "company_name": "company", "title": "job_title" } }
```

`column_map` is Instantly field → CSV column. Everything not mapped to a built-in field becomes a custom variable, plus camelCase mirrors (`firstName`, `companyName`) for older copy.

## Hard rules

- The runbook is the contract. If an action isn't allowed there, escalate; don't improvise.
- Numbers in Slack and the ops log come from the script's API calls in the same run. Never type a number from memory.
- Activating campaigns is allowed for this client's own account by explicit instruction (2026-11-03). It remains off for other clients until their runbook says otherwise.
