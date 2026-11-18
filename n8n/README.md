# Instantly Positive Reply → Phone Lookup → Email Alert (n8n)

When a lead is marked **Interested** in Instantly, this workflow hunts their cell
number across four sources and emails a briefing to **you@yourcompany.com**
within a couple of minutes.

**Sources, in order of trust:**

1. **Email signature** of the lead's actual reply (free, parsed with labels: `M:`/`Cell` vs `O:`/`Direct`, fax discarded)
2. **FastPeopleSearch** via Apify actor (Cloudflare handled by Bright Data)
3. **TruePeopleSearch** via Apify actor
4. **LeadMagic mobile-finder** (fires on every run; 5 credits per hit, free on miss)

Every number is deduped, typed, and scored 35–99. Numbers corroborated by 2+
sources get a +15 bonus. Office/landline numbers land in a separate
"Other numbers found" block instead of being thrown away.

---

> **New to n8n?** Follow **[SETUP-GUIDE.md](SETUP-GUIDE.md)** instead — it's a
> click-by-click walkthrough of everything below, written so anyone can do it.

## Setup (one time, ~15 min)

### 1. Install the two verified community nodes

n8n → **Settings → Community nodes → Install** (both are n8n-verified; on n8n
Cloud you can also install them straight from the node search panel):

- `n8n-nodes-instantly` — official Instantly node (by Instantly)
- `@apify/n8n-nodes-apify` — official Apify node

### 2. Import the workflow

n8n → **Workflows → ⋯ → Import from File** → pick
`instantly-positive-reply-phone-lookup.json` (or paste its contents).

### 3. Create 4 credentials

| n8n credential name | Credential type | Value |
|---|---|---|
| `Instantly API` | **Instantly API** (from the Instantly node) | Just paste `<INSTANTLY_API_KEY>` from root `.env` — no "Bearer" prefix, the node adds it |
| `Apify API` | **Apify API** (from the Apify node) | Just paste your Apify token (Apify Console → Settings → API tokens) |
| `LeadMagic` | **Header Auth** (generic — LeadMagic has no native node) | Header name: `X-API-Key` · Value: `<LEADMAGIC_API_KEY>` from root `.env` |
| `Gmail (you@yourcompany.com)` | Gmail OAuth2 | Standard n8n Google OAuth flow |

Then open each node and select the matching credential (the import ships with
placeholder credential IDs): **Get Lead Record**, **Get Latest Reply** →
Instantly API · **FastPeopleSearch**, **TruePeopleSearch** → Apify API ·
**LeadMagic Mobile** → LeadMagic · **Send Alert to Me** → Gmail.

> **Why is "Get Latest Reply" an HTTP Request node and not the Instantly
> node?** The native node's *Get Many Unibox Messages* operation always sends
> `is_unread=false`, which filters OUT unread emails — and a positive reply
> that just triggered the webhook is usually still unread, so the node would
> miss it. The HTTP node hits the same `/api/v2/emails` endpoint and reuses
> the same native **Instantly API credential** (via n8n's predefined
> credential type), so there's nothing extra to configure.

### 4. Register the webhook in Instantly

1. In n8n, open the **Webhook** node and copy the **Production URL**.
2. Instantly → **Settings → Integrations → Webhooks → Add webhook**.
3. Paste the URL. Event: **Lead is marked as interested**.
   Optionally add a second registration for **Meeting booked** and any positive
   custom labels — the workflow's event gate accepts those too and rejects
   `not interested`.
4. **Activate** the workflow in n8n (toggle top-right).

> API alternative: `POST https://api.instantly.ai/api/v2/webhooks` — confirm the
> body schema against `https://api.instantly.ai/openapi/api_v2.json` first.

### 5. Config node (optional tweaks)

Open the **Config** node to change: recipient (`ALERT_TO`), Apify actor slugs,
or `MAX_RECORDS` (person records pulled per people-search site, default 3).

---

## What the email looks like

Subject: `New Lead: Jane Doe phone number`

> **Acme Logistics**
> Freight & Logistics
> Jane Doe
>
> **Cell numbers found:**
> +1 (512) 555-0142 — 99% (email signature + FastPeopleSearch + TruePeopleSearch: labeled mobile/cell — corroborated by 3 sources)
> +1 (512) 555-0311 — 90% (LeadMagic: B2B mobile-finder)
>
> **Other numbers found:**
> +1 (512) 555-0100 — 40% (email signature: labeled office/direct)

If nothing is found anywhere, the alert still sends (a positive reply is worth
knowing about even without a number).

---

## How the pieces work

- **Lead enrichment**: the Instantly webhook payload only carries name/company/
  email. Industry, location, and LinkedIn URL come from the lead's
  `custom_variables` via `POST /api/v2/leads/list` — these exist because the
  campaign upload skill passes every extra CSV column through
  (`company_industry`, `location`, `linkedin_url`, `company_phone`).
- **Location parsing**: Sales Nav free text (`"Austin, Texas, United States"`,
  `"San Francisco Bay Area"`) is parsed to city + 2-letter state with a full
  state map and a ~60-entry metro map. **If no US state can be parsed, the two
  people-search scrapers are skipped** (they need a state and would return
  garbage) and the run goes straight to LeadMagic.
- **Wrong-person guard**: people-search records are only used when the record
  name contains the lead's first *and* last name; city-match records score 75,
  state-only 50, secondary listed numbers −10.
- **Switchboard guard**: any number equal to the lead's `company_phone` custom
  variable is discarded everywhere.
- **Failure isolation**: every external call has `onError: continue` — a
  Cloudflare block, Apify timeout, or LeadMagic 402 never kills the run; the
  email sends with whatever the surviving sources found.
- **Fast ACK**: the webhook responds 200 immediately so Instantly never retries
  during slow (30–90 s) Apify runs.

## Cost per positive reply

| Item | Cost |
|---|---|
| Apify actor starts (2 × $0.10) + up to 6 records × $0.003 (each run hard-capped at $1 via *Maximum Cost per Run*) | ~$0.22 |
| LeadMagic mobile-finder | 5 credits if found, free on miss |
| Instantly API calls, signature parse, Gmail | free |

## Testing checklist

1. **Actor smoke test**: run each Apify actor once from its console page with a
   known real person (`searchMode: "name"`, firstName/lastName/city/state) and
   confirm the output items carry `name`, `currentAddress`, `phones[]`.
2. **Payload check**: n8n → *Listen for test event* on the Webhook node, then
   mark a test lead Interested in Instantly (or `POST /api/v2/webhooks/{id}/test`).
   Confirm `lead_email`, `firstName`, `companyName` arrive as expected.
3. **Pinned dry run**: pin that test payload and execute the full workflow;
   check each node's output panel, especially city/state out of *Build Search
   Keys*.
4. **Zero-result run**: use a fabricated name; the "no numbers found" email
   must still arrive.
5. **Go live**: activate, mark one real lead Interested, confirm the alert.

## Compliance note

Cell numbers are personal data. TCPA, state mini-TCPA, and Do-Not-Call rules
apply to calls and especially texts — calling a lead who just replied to you is
normal business practice, but don't feed these numbers into automated SMS.
