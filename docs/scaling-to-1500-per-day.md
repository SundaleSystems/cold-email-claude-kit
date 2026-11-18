# Worked example: sending 1,500 emails every day

A real capacity plan from a ~115-inbox Instantly workspace, with the account-specific
details removed. Swap in your own numbers; the math is the useful part.

## 1. Know your ceiling first

| Thing | Example value | Where to get yours |
|---|---|---|
| Inboxes | 115 active, warmup on, 20/day each = **2,300/day hard cap** | `/instantly-inbox-manager` health dashboard |
| Goal | 1,500/day = 65% of cap (about 35 inboxes can drop out before the goal is at risk) | your call |
| Actual sends, last 7 days | often far below goal because live campaigns run out of fresh leads | Instantly analytics |
| Credit balances | Vayne scraping, LeadMagic, MillionVerifier | each tool's dashboard |

## 2. The math

**Sequence shape.** 3 touches per lead. Replies, bounces and unsubscribes stop ~5% of
sequences early, so one lead ≈ **2.85 sends** over its life.

**Steady state.** 1,500 sends/day ÷ 2.85 = **~530 new leads must enter a sequence every send day.**
Round to **550/day** for safety.

| Horizon | New send-ready leads needed |
|---|---|
| Per send day | 550 |
| Per week (5 send days) | 2,750 |
| Per month (22 send days) | **~12,000** |
| If you send 7 days/week | 770/day → **~16,500/month** |

**Ramp.** Only step 1 fires on day 1, so day 1 needs 1,500 *new* leads, day 2 ~1,100, day 3 ~800
before follow-ups carry the load. **Have ~3,500–4,500 verified leads on hand the day you start.**

**Pipeline yield** (Vayne → LeadMagic → verify), measured across several runs:

| Stage | Keep rate | Leads from 1,000 scraped |
|---|---|---|
| Vayne scrape → title/ICP filter | 85% | 850 |
| LeadMagic email found | ~65% | 550 |
| Verified "ok" only | ~80% | 440 |
| **Send-ready** | **~44%** | **~440** |

So **1 send-ready lead ≈ 2.3 Vayne credits ≈ 0.9 LeadMagic credits ≈ 0.6 verification credits.**

**Credits per month (5-day sending, 12,000 send-ready):** ~27,000 Vayne scraping, ~11,000
LeadMagic (+3,000 if you validate with LeadMagic instead of MillionVerifier), ~15,000
MillionVerifier.

## 3. How many leads and campaigns

- **Buffer:** keep ≥5 send days of verified leads (≥2,750, verified <30 days ago) in approved
  runbook stock at all times. That is the account manager's `min_runway_days`.
- **Campaign unit:** one ICP × one offer × **2,500 leads**. Smaller arms can't be read
  statistically (see `docs/lessons-learned.md`). Attach all healthy inboxes to every campaign;
  Instantly's per-inbox limit spreads the load.
- **Concurrency:** **3 live campaigns at a time**, each ~500 sends/day. Bounce-protect pauses a
  *whole* campaign, so with 3 live, one pause costs a third of the day, not all of it.
- **Lifecycle:** a 2,500-lead campaign injects for ~14 send days and finishes follow-ups ~7 days
  later (≈3-week life). To keep 3 live, **launch one new campaign a week** and keep **1 spare in
  DRAFT** for the account manager to activate.

## 4. ICP rotation

Prioritize ICPs that already have a sequence written, so copy is never the bottleneck. Add one new
ICP per month via `/campaign-strategy` → `/campaign-copywriting`.

**Personalization budget:** per-lead AI personalization with sub-agents costs ~9M tokens per
~1,700 companies. Personalize **one** of the three live campaigns and run the others on static copy
with merge variables. Treat that as the experiment (personalized vs static, same ICP).

## 5. Weekly operating cadence

| Day | Do |
|---|---|
| Mon | Scrape 1 ICP via `/vayne-lead-pipeline` (~6,000 scraped → ~2,600 send-ready). |
| Tue | Emails + verification finish; `/list-quality-scorecard`; add to runbook as approved stock. |
| Wed | `/instantly-campaign-upload-public` → DRAFT (2,500 leads). Account manager activates when a live campaign runs dry. |
| Daily 07:30 | Account manager: sends ≥ floor? runway ≥5 days? bounce <3%? Escalates to Slack otherwise. |
| Fri | Check 7-day sends, bounce by campaign, inbox health. `/positive-reply-scoring` on any campaign at day 21. |
| Monthly | Top up credits before they run out. |

## 6. Risks that break the floor

- **Lead-source credits run dry.** Scraping is usually the first bottleneck.
- **Stale verification** → bounce-protect → campaign pause. Never upload anything verified >30 days ago.
- **Weekends.** Instantly schedules default to Mon–Fri. "Every single day" means 40% more leads, and
  weekend reply rates are lower. 5-day sending at 1,500 (7,500/week) is usually the better choice.
- **Single-campaign dependence.** If one or two campaigns carry everything, sends crater the day they run out.
- **Personalization throughput** is the slowest step in the pipeline; cap it at one campaign.
