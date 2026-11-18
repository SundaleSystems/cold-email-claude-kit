# Account Manager

The accountable account manager for cold-email clients. One deterministic script checks the
Instantly account every morning, keeps a campaign running, keeps sends at or above the daily
floor, and posts what it did and what it needs to Slack. A Claude Code skill
(`/account-manager`) handles the judgment work the script escalates.

```
account-manager/
├── scripts/
│   ├── daily.ts            the brain — rules R1–R6, runs every morning
│   ├── add-leads.ts        CSV → campaign (workspace dedupe, plan-limit probe)
│   ├── clone-campaign.ts   new campaign from an existing sequence + healthy inbox pool
│   ├── campaign.ts         activate / pause / daily-limit / inboxes / list
│   ├── heartbeat.ts        alerts if today's run never happened
│   └── _lib.ts             env, Instantly API, Slack, CSV, runbook + state I/O
├── clients/<client>/
│   ├── runbook.json        targets, autonomy switches, inbox pool, lead stock
│   ├── ops-log.md          append-only history
│   ├── state/              daily snapshots (bounce guard diffs these)
│   └── requests/           hand-offs to the follow-up skill
├── launchd/                07:30 daily run, 11:00 heartbeat
├── run-daily.sh            what launchd calls (optional Claude follow-up step)
└── install-launchd.sh      installs both jobs
```

## Run it

```bash
npx tsx account-manager/scripts/daily.ts --client=example-client --dry   # preview
npx tsx account-manager/scripts/daily.ts --client=example-client         # real
./account-manager/install-launchd.sh                                      # schedule daily
tail -f account-manager/logs/daily.log
```

Needs in `.env`: `INSTANTLY_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_ALERT_CHANNEL`.

## What "accountable" means here

| Layer | Mechanism |
|---|---|
| Does the job daily | launchd job, not a calendar reminder |
| Can't silently fail | heartbeat at 11:00 posts red if no state file for today; fatal errors post red immediately |
| Acts only inside its mandate | `autonomy.*` switches in the runbook; anything else is an escalation with a code |
| Never lies about numbers | every figure in Slack and the ops log is from the same run's API calls |
| Leaves a trail | `state/<date>.json` + `ops-log.md`, append-only |
| Hands off cleanly | `requests/*.json` + `/account-manager follow-up` for copy, verification, sourcing |

## Escalation codes

`INBOX_HEALTH` · `BOUNCE` · `RESUME_CANDIDATE` · `ACTIVATE` · `NEED_CAMPAIGN` · `NEED_LEADS` · `NOTHING_RUNNING` · `PLAN_LEAD_LIMIT` · `UPLOAD_ERROR` · `STOCK_FILE`

## Adding a second client

Copy `clients/example-client/` to `clients/<slug>/`, edit the runbook (set every
`autonomy.may_*` to `false` until the client has agreed what the agent may do alone),
add a launchd plist with the new slug, install.
