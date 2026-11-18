# Speed to Call — phone-hunt

When Instantly marks a lead **interested**, this function hunts down their
mobile number in seconds so you can call while the reply is still warm.

It runs on the same framework and the same Supabase project ("Speed to
Lead", ref `<your-project-ref>`) as `reply-gate/`, and subscribes to the
same Instantly event — Instantly allows more than one webhook per event,
so the two systems run side by side, each with its own dedup.

## What it does

On a positive webhook it responds `{ok:true}` immediately, then in the
background:

1. **One-shot dedup** — first interested event per (campaign, lead) wins;
   retries and repeat events are harmless no-ops.
2. **Pull context from Instantly** — the lead's latest reply (for the
   signature) and the lead record's custom variables (location,
   linkedin_url, company_phone, company_industry).
3. **Hunt four sources in parallel:**
   - **Email signature** — parses the reply, labels each number
     mobile/office/fax by the words in front of it, drops the company
     switchboard. Free, always runs.
   - **FastPeopleSearch** + **TruePeopleSearch** — via Apify actors, only
     when a US state resolved from the lead's location.
   - **LeadMagic** mobile-finder — one API call, work email → mobile.
4. **Score & dedupe** — signature-mobile 95, LeadMagic 90,
   signature-unknown 70, people-search 75 (city) / 50 (state only),
   signature-office 40. The same number from two sources is corroborated
   (+15, capped 99).
5. **Alert** — a Slack ping (always, even on zero results) and, if the
   Gmail secrets are set, an email to yourself. Every number carries its
   score, its sources, and a per-source status footer so a dead source is
   visible in the very alert it degraded.

Unlike reply-gate there is **no cron and no delayed send** — one pass, the
alert is out in under ~90 seconds.

## Deploy

1. **Schema** — paste `supabase/schema.sql` into the Supabase SQL Editor
   (same project as reply-gate) and Run. Just one table + a dedup index;
   idempotent.

2. **Secrets** — create an Apify account, rent the two actors once (search
   for "fastpeoplesearch" / "truepeoplesearch" by `jungle_synthesizer`),
   grab your API token, then:

   ```bash
   supabase secrets set \
     PHONE_HUNT_WEBHOOK_SECRET=<invent-a-long-random-string> \
     APIFY_TOKEN=<from apify.com> \
     LEADMAGIC_API_KEY=<same as root .env> \
     --project-ref <your-project-ref>
   ```

   `INSTANTLY_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_ALERT_CHANNEL` are already
   set for reply-gate and are reused. See `secrets.example` for the rest.

3. **Deploy** (`--no-verify-jwt`: Instantly can't sign a Supabase JWT; the
   secret in the URL is the auth):

   ```bash
   supabase functions deploy phone-hunt --no-verify-jwt --project-ref <your-project-ref>
   ```

4. **Register the webhook** — in Instantly, add a webhook on
   **"Lead marked as interested"** pointing at:

   ```
   https://<your-project-ref>.supabase.co/functions/v1/phone-hunt?secret=<PHONE_HUNT_WEBHOOK_SECRET>
   ```

   Leave reply-gate's existing webhook alone. Save this URL (with the
   secret) into `phone-hunt/webhook-url.txt` — it's gitignored. Never paste
   it into a chat.

5. **Backfill lead location** (see below) so the people-search step has a
   city/state to search.

## Backfill: give existing leads a location

FastPeopleSearch/TruePeopleSearch need a city/state, which lives in the
lead's `location` custom variable. Leads uploaded before the
`skills/instantly-campaign-upload-public` allowlist fix don't have it. Two
parts, both already in place in the repo:

- **Future uploads** carry it automatically — `location`, `company_phone`,
  and `company_industry` were added to the upload allowlist.
- **The live campaign** — backfill from the final-list CSVs. Dry-run first:

  ```bash
  npx tsx phone-hunt/scripts/backfill-lead-vars.ts \
    --campaign=<campaign-id> --dry-run \
    Lead-Lists/4-Final-Lead-Lists/ecom-dtc-content-us_2026-08-20_final.csv

  # looks right? drop --dry-run to write.
  ```

  It merges into existing custom variables (never clobbers
  `situation_line` etc.) and is safe to re-run.

Without a location the function still works — it just skips the two
people-search sources and runs signature + LeadMagic only.

## Email alerts (optional)

Instantly's API can only reply to existing threads, so a fresh alert email
needs its own transport. The Gmail module activates only when all three
`GMAIL_*` secrets are set; otherwise Slack carries the alert alone.

One-time setup: create an OAuth 2.0 **Desktop app** client in Google Cloud
(APIs & Services → Credentials), enable the Gmail API, mint a refresh
token with the `https://www.googleapis.com/auth/gmail.send` scope and
offline access (the OAuth Playground is the quickest path), then set
`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. No
redeploy needed — the next hunt picks them up.

## Verify

- Deterministic tests (pure logic, no network): `tests/smoke.ts`. Run with
  Deno (`deno run tests/smoke.ts`) — no secrets needed.
- Live: send a positive test payload for a real campaign lead and confirm
  a Slack alert plus a `phone_hunt_log` row; re-send it to confirm the
  dedup skip; `supabase functions logs phone-hunt` for the background
  trace.

## Deploy-time checks (isolated so fixes are one-liners)

- **Apify actor input** — `apify.ts` builds `{searchMode, firstName,
  lastName, state, city, maxItems}` from the n8n template. Run each actor
  once from the Apify console and adjust the input builder if its schema
  differs.
- **LeadMagic path** — `leadmagic.ts` uses `/v1/people/mobile-finder`; a
  404 in the alert footer means the path is wrong (other repo scripts use
  unversioned root paths).
- **Edge Function wall-clock** — the two actors + LeadMagic run in parallel
  with a 60s per-call timeout; watch `duration_ms` in the log and tighten
  `APIFY_TIMEOUT_MS` if runs get killed.

## Cost

Typically under $0.50 per positive reply (Apify ~$0.05–0.25 per actor,
hard-capped $1 each; LeadMagic 5 credits on a hit, free on a miss),
worst-case ≈$2.10. At single-digit positive replies a day, negligible.
