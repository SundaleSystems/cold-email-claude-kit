# The Reply Gate

An AI that answers your interested cold-email replies within minutes, and refuses
to send anything it cannot back up.

Built from the "Reply Gate" setup guide, adapted for this workspace:
**Instantly** (sending platform), **Calendly** (calendar — not Cal.com),
**Supabase** (database + the function), **Anthropic API** (two models),
**Slack** (control panel).

## How it works

```
Instantly: lead marked Interested
        │  webhook (fires once per lead per campaign)
        ▼
┌─ Supabase Edge Function: reply-gate ─────────────────────────┐
│ 1. Pull the actual reply + the actual lead from the API      │
│ 2. Skip the noise (OOO / bounce / unsubscribe) — no AI yet   │
│ 3. Load the offer sheet via campaign_map (no map = no reply) │
│ 4. Pull two real free slots from Calendly (non-fatal)        │
│ 5. Model 1 drafts from the offer sheet ONLY;                 │
│    code appends the times and the sign-off                   │
│ 6. THE GATE:                                                 │
│    a. deterministic code checks (length, nouns, prices,      │
│       banned phrases, markdown, links, sign-off, greeting)   │
│    b. independent verifier model (never sees the drafter's   │
│       reasoning; evidence before verdict; 5 narrow criteria) │
│    c. confidence threshold 0.8 + always-escalate intents     │
│    One retry allowed, fed by whichever layer failed.         │
└──────────────────────────────────────────────────────────────┘
   all gates pass                     any gate fails / any doubt
        │                                   │
        ▼                                   ▼
  queued, send_after = +4 min         HELD → Slack with their reply,
  pg_cron sweep every minute,         the draft, and the exact reason.
  atomic claim, sent from the         You send it yourself — which is
  campaign's own mailbox              what you were doing before, so
                                      the failure case costs nothing.
```

Everything — held, sent, skipped, shadow — is reported to Slack and recorded in
the `replies_log` table.

## Layout

```
reply-gate/
├── supabase/
│   ├── schema.sql                    ← ONE file: tables, claim function, cron, seed
│   └── functions/reply-gate/         ← ONE edge function, both routes
│       ├── index.ts                  ← webhook + send-sweep router
│       ├── pipeline.ts               ← the flow above
│       ├── drafter.ts                ← model 1 + code-assembled times/sign-off
│       ├── checks.ts                 ← deterministic gate layer
│       ├── verifier.ts               ← model 2, independent, evidence-first
│       ├── sender.ts                 ← once-a-minute sweep, atomic claim
│       ├── noise.ts                  ← OOO / bounce / unsubscribe filter
│       ├── instantly.ts / calendly.ts / slack.ts / claude.ts / db.ts
│       └── config.ts / types.ts
├── tests/smoke.ts                    ← deterministic-layer tests (no network)
└── secrets.example                   ← the secrets list (values live in Supabase only)
```

## Setup — eight steps, in order

### 1. Stand up the database
Create a Supabase project → SQL Editor → paste all of `supabase/schema.sql` → Run.
That is the whole step. It creates `knowledge_base` (offer sheets + one global row),
`campaign_map`, `replies_log`, and the atomic claim function, and seeds template rows.

When you want to change the schema later, edit that one file and re-run it.

### 2. Write the offer sheet  ⟵ the step that decides whether replies are any good
Supabase Table Editor → `knowledge_base`. Fill in the `global` row and replace the
`example-offer` row with a real one (rename `key` to a real slug). **Give it half a
day, not half an hour.** The models may state facts from this sheet and nothing
else; a missing fact means the reply is held, a wrong fact means a confidently
wrong reply.

Fields that matter most:
- `original_pitch` — the EXACT cold email copy + CTA. Most skipped, most important.
- `offer_facts`, `pricing_policy` (+ `pricing_facts` if quoting), `common_questions`
- `ideal_replies` — 2-3 real examples; these control wording more than any rule
- `business_noun` — the ONE word for their business ("firm", "business"). Enforced by code.
- `sender_signoff` — appended by code, never written by the model

The pipeline refuses to draft while a sheet still contains "FILL ME IN".

### 3. Collect the keys
Supabase Dashboard → Edge Functions → Secrets. Set everything in `secrets.example`.
Never into a file, never into a message. The service role key and the Instantly
key can respectively bypass your database and send mail as you — if either ever
leaks, rotate it that day.

### 4. Deploy the function
```bash
supabase functions deploy reply-gate --no-verify-jwt
```
(`--no-verify-jwt` because Instantly can't sign a Supabase JWT — your
`INSTANTLY_WEBHOOK_SECRET` in the URL is the auth.) The function answers the
webhook immediately and does the slow work in the background, and the same
function also handles the send sweep: one program, one place to look.

### 5. Point Instantly at it
Instantly → Settings → Integrations → Webhooks → new webhook on the
**"Lead marked as interested"** event:
```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/reply-gate?secret=YOUR_WEBHOOK_SECRET
```
This event fires once, the first time a lead turns Interested — so the system
answers the first positive reply and stays out of the conversation afterwards
(the database enforces this too). Also check *how* Interested gets applied in
your workspace (by hand vs Instantly's AI classifier) — that setting is the
trigger for everything downstream.

### 6. Schedule the sender
Bottom of `schema.sql`: fill in your project ref + secret in the commented
`cron.schedule` block, uncomment, run it in the SQL Editor. It sweeps every
minute; approved replies wait four minutes before sending so a reply never
lands three seconds after theirs — and so a Slack notification gives you a
window to stop it.

### 7. Run it in shadow mode  ⟵ weeks, not days
`SHADOW_MODE=true` (the default). Everything runs for real except the send:
every draft goes to Slack with the verdict attached. Read them daily, send the
good ones by hand, and fix the **offer sheet** (not the draft) wherever a draft
is wrong. Stay here until the drafts stop surprising you.

### 8. Go live, narrowly
Set `SHADOW_MODE=false`, then flip `live=true` in `campaign_map` for ONE
campaign. Watch the first ten sends as closely as you watched the shadow drafts.
Add campaigns one at a time, each with its own finished offer sheet. Unmapped
campaigns are held, never answered generically — expansion is deliberate by
construction.

## Running it day-to-day (no developer needed)

| You want to | Do this | Takes effect |
|---|---|---|
| Stop it sending | Set `SHADOW_MODE=true` in Edge Function secrets | Next reply |
| Stop one campaign | Set its `live=false` in `campaign_map` | Next reply |
| Stop it entirely | Turn off the webhook in Instantly, or `select cron.unschedule('reply-gate-send-sweep');` | Immediate |
| Stop one queued reply | Set that row's `status` to `held` in `replies_log` (within the 4-min window) | Immediate |
| Change what it says | Edit the offer sheet row | Next reply |
| Answer a new objection | Add to that offer's `common_questions` | Next reply |
| Add a campaign | Add a row to `campaign_map` | Next reply |
| Add a new offer | New `knowledge_base` row, set `business_noun`, map its campaigns | Next reply |
| Change models / delay / threshold | Edge Function secrets (`DRAFT_MODEL`, `SEND_DELAY_MINUTES`, `CONFIDENCE_THRESHOLD`) | Next reply |
| See what happened | Slack for the commentary, `replies_log` for the full record | Always on |

## Tests

```bash
deno run --allow-read --allow-env tests/smoke.ts
```
(with any dummy values for the required env vars). Covers the noise filter,
every deterministic check, and body assembly. The model layers are exercised in
shadow mode against real replies — that is what the shadow period is for.

## Traps this build already guards against

1. **Guessed business nouns** — `business_noun` + a code check that fails any
   other generic noun unless it appears in the lead's own name/domain.
2. **Reply without the lead** — the lead lookup pulls name/company/website/
   personalization, and is non-fatal (degrades rather than dies).
3. **Verdict-before-evidence** — the verifier's JSON fields are ordered so all
   evidence comes before any pass/fail, and the overall verdict is recomputed
   from the criteria in code.
4. **Verifier re-judging lead quality** — its fifth criterion asks only whether
   the draft *describes the lead accurately*; sales fit is explicitly not its
   call, and rubric examples are kept abstract.
5. **Leads existing only as a Slack message** — every touched reply is a row in
   `replies_log` regardless of outcome. (A separate CRM-sync job is still worth
   adding later; keep it separate from this system so either can be paused
   without touching the other.)

## When not to run this

Two interested replies a week? Answer them yourself. Can't write the offer
sheet? The system will broadcast your uncertainty at speed. Nobody reading the
Slack channel? The escalation path *is* the safety net — a held reply nobody
looks at is just a slower way to lose the lead.
