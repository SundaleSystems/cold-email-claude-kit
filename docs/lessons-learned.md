# Lessons learned (the expensive way)

Field notes from running this kit on live campaigns. Each one cost money, credits or
deliverability before it got written down. Read this before your first real list build.

---

## Lists and data

### Never use the LeadMagic bulk CLI (`lm enrich`) for email finding
One ~2,000-row run burned **3,574 credits in 4.5 hours and delivered zero output**:
- It silently falls back from email-finder to **mobile-finder at 5 credits per hit**. There's no email-only flag. About 65% of the spend went on phone numbers nobody asked for.
- Its browser-session login expired ~2.5 hours in, causing 401 retry storms.
- It holds results **in memory** and writes only at the end. Killing it loses everything you paid for, and LeadMagic re-charges repeat lookups.

**Do instead:** `.claude/skills/vayne-lead-pipeline/scripts/leadmagic-find-emails.ts`. It finds emails only (1 credit per found email, misses are free), writes a JSONL journal per row, supports `--resume`, and has a `--dry-run` you should always run first.

### LeadMagic rejects link-aggregator "domains"
Sales Navigator exports copy whatever the company typed into its LinkedIn website field, so `bit.ly`, `linktr.ee`, `lnk.bio`, `tinyurl.com` and similar end up as the company domain. LeadMagic returns HTTP 400 for these. **Fix:** blank the domain and retry on company name only. That recovered about 42% of affected rows.

### The raw Sales Nav export has revenue data, so filter on it before paying for emails
The raw Vayne export includes `linkedin company revenue range` (60–78% filled), plus description, specialities and founded year. The normalize step drops these. Keep the raw file, join those columns back by `linkedin_url` as a sidecar, and **apply revenue filters before email finding**. On one run this removed 28% of companies up front and roughly doubled end-to-end yield. See `scripts/ecom-qualify/1-enrich-from-raw.py` and `2-revenue-trim.py`.

### Verification goes stale
A list verified six weeks earlier bounced 5.2% and tripped Instantly's bounce-protect, which pauses the whole campaign. **Re-verify anything older than 30 days.** The account manager enforces this with `max_verification_age_days`.

### If you can't use MillionVerifier, LeadMagic validation is a usable fallback
`POST https://api.leadmagic.io/v1/people/email-validation` costs 0.25 credits (0 for catch-all/unknown). About 91% of finder output came back `valid`. Keep only `valid` and drop `valid_catch_all` too. Calls are slow, so run at concurrency ~15.

### Finding missing company domains: use agents, not APIs
For micro-SMBs (contractors, local services), enrichment APIs have almost no coverage. Claude sub-agents doing web search, ~20 companies per Sonnet agent, with a strict "never guess" rule, verified domains for 46% of 710 companies. Then `dig` every domain (agents cite dead directory domains) and run an adversarial verify pass on every medium-confidence answer.

---

## Instantly API gotchas

1. **Cloudflare blocks Python's default User-Agent.** `urllib`/`requests` without a UA header get `403 error code: 1010`. This isn't an auth problem; send any normal UA header (e.g. `curl/8.7.1`).
2. **`GET /api/v2/accounts/analytics/daily` returns 413** on large workspaces (~100+ inboxes) unless you pass an `emails=` filter. Per-campaign stats are better derived from `POST /api/v2/leads/list` anyway.
3. **Google Workspace DKIM uses the `google` selector**, not `default`. Run `check-domain-auth.ts --dkim-selector=google`, or the audit reports false "missing DKIM".
4. **Your plan has a hard lead-upload cap.** `leads/add` returns `remaining_in_plan`. When it hits zero, the next batch fails *entirely* with `403 Lead limit reached`. Before any upload >1,000 leads, send a 1–2 lead test batch and read that number.
5. **`email_reply_count > 0` counts auto-replies.** `GET /api/v2/emails?email_type=received` returns only real replies.
6. **Deleting leads is slow:** 50 per call, ~60 s per call. Archive first.
7. **`custom-tags/toggle-resource` uses `resource_type: 1` for accounts** (2 = campaigns).

---

## Experiments and measurement

### Most "copy tests" are badly under-powered
A 7-variant first-email test had ~320 sends per arm and could not tell the variants apart (p=0.90). **To detect a 2× lift from a ~1% reply baseline you need ~2,500 sends per arm.** Cap tests at 2 variants and size them properly. (`/experiment-design` quotes lower minimums; use 2,500.)

### Decide on reply rate; report positive rate as directional
Positive reply rates (~0.1%) are too rare to decide anything: a 2× read would need ~26,000 leads per arm.

### The recipient's mail host predicts replies more than copy does
In one campaign: Google-hosted recipients replied 1.97%, Microsoft 0.53%, catch-all/unknown 0.18% (p=0.006). Consider dropping catch-all/unknown-ESP leads. In that campaign they were 25% of the list and produced one reply.

### A failed campaign is usually offer ↔ audience fit, not copy
The post-mortem of a 2,262-lead campaign (0.93% replies, 0.088% positive) found deliverability fine (SPF/DKIM/DMARC valid, warmup 100, bounce 1.6%). The pitch assumed the recipients had inbound lead flow, and most didn't. Check the offer's core assumption against the list before blaming copy. Other fixes from that post-mortem:
- Go past 2 steps. Step 2 performed as well as step 1 and produced 48% of replies.
- Add an unsubscribe line. 29% of replies were manual removal requests.
- Enforce the industry filter. 26% of the list had drifted outside it.

`scripts/campaign-postmortem/` contains the extraction and analysis scripts used.

---

## Copy rules

1. **One question mark per email**, as the closing CTA. Turn probing openers into statements ("my bet is you find out days later"), not questions.
2. **The CTA asks for the meeting.** "Want this free thing?" gets replies, not meetings. Deliver the lead magnet *on* the call ("you keep the report either way").
3. `/spam-word-checker` runs on everything.

---

## Replying to prospects

Every reply goes into exactly one bucket: `positive_interested`, `positive_price`, `positive_soft`, `positive_referral`, `neutral_question`, `negative_notnow`, `negative_notfit`, `negative_hostile`, `unsubscribe`, `ooo`, `bounce`, `other`. Each positive bucket has a fill-in-the-blank template; the blanks change per offer and the skeleton doesn't.

- **Interested:** "Sounds great" + two specific afternoon times + "let me know which and I'll send a Google Meet invite" + "or send your calendar / here's mine [Calendly]". Always give three scheduling paths.
- **They propose a time:** accept it, say you'll send the invite, and stop. No counter-slots, no questions:
  > Hi Sam,
  >
  > Sounds good. I'll shoot over a google meet invite for Tuesday 3pm EST.
  >
  > Look forward to connecting.
- **They send their own calendar link:** don't auto-reply. A human books it.
- **Price:** "Cost varies, and we've built this for as little as $X–Y. Are you open to a 15-min call in the next hour? I can scope it and give you a price. I'll also include [lead magnet]."
- **Info request:** a one-line high-level answer, then push to a 15-minute call.
- **"Reach out next quarter":** agree, then ask for a 15-minute intro next week "so you can see if it even makes sense".
- **Referral:** "Thanks, would you mind introducing us by email?"

`reply-gate/` implements this as an AI auto-replier with deterministic safety gates and a shadow mode.

---

## Running Claude sub-agents at scale

- **Personalization:** one Sonnet sub-agent per 30 companies, 8–10 in flight. Calibrate 1 → 10 → 10 → 10 with a verifier each round and lock after two clean rounds. Then regex-gate 100% of output, run a Sonnet verifier per batch, and have a top-tier model spot-check ~30. About 9M tokens for ~1,700 companies.
- **Web research is expensive:** ~80–115k tokens per company when each gets its own agent. Use Sonnet for collection and the top tier only for QA. Put 2–3 companies per agent (≈40% cheaper). Ask only for the evidence the deliverable needs. Report the token burn after the first wave.
- Have agents write results to files and return a one-line "DONE", so the parent context stays small.

---

## Deliverability on your main domain

If a prospect says your *main-domain* mail is landing in spam, read your DMARC aggregate (`rua`) reports. In one case, an unknown cloud server was sending unauthenticated mail as the domain. Moving DMARC from `p=none` to `p=quarantine` contained it. Send cold email only from lookalike domains, never your main one, and run mail-tester.com (10/10 is achievable) after any DNS change.
