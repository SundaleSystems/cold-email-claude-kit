---
name: vayne-lead-pipeline
description: End-to-end lead-list pipeline — Sales Navigator scraping via Vayne MCP, LeadMagic email finding, MillionVerifier validation, and a scored final list. Takes either a plain-English ICP description OR a pasted Sales Navigator URL (or an existing CSV), estimates and scrapes it, finds emails for leads missing them, verifies EVERY email, and writes an ok-only send-ready CSV + quality scorecard to Lead-Lists/4-Final-Lead-Lists/. Use when the user says "build me a lead list", "run the lead pipeline", "run the lead list generation process", "scrape sales navigator", "scrape this sales nav URL", "vayne", "find and verify leads", or "get me leads for <ICP>". Requires the Vayne MCP server connected plus LEADMAGIC_API_KEY and MILLIONVERIFIER_API_KEY in .env.
---

# Vayne Lead Pipeline

The canonical lead-list build, end to end:

```
Vayne (Sales Nav scrape)  →  LeadMagic (find missing emails)  →  merge
        →  MillionVerifier (keep ONLY ok — no catch-all, no bad)  →  final list + scorecard
```

A small percentage of Vayne-scraped leads come with emails. LeadMagic finds emails for
the rest using name + company domain/name. The merged list — INCLUDING the
Vayne-provided emails — always goes through MillionVerifier, and only `ok` emails make
the final list.

## What this skill produces

All files share one run ID: `<icp-slug>_<YYYY-MM-DD>` (append `-2`, `-3` if that ID already exists).

```
Lead-Lists/1-Vayne/<run-id>_vayne-raw.csv         # raw Vayne download (if a download URL was available)
Lead-Lists/1-Vayne/<run-id>_vayne.csv             # canonical-columns scrape output (post-trim)
Lead-Lists/1-Vayne/<run-id>_vayne-dropped.csv     # trimmed rows + drop_reason (Step 3.5)
Lead-Lists/scraped-registry.csv                   # cross-run registry of every scraped linkedin_url
Lead-Lists/2-Lead-Magic/<run-id>_leadmagic-found.csv  # rows whose email LeadMagic found
Lead-Lists/2-Lead-Magic/<run-id>_no-email.csv     # rows with no email anywhere (kept as record)
Lead-Lists/2-Lead-Magic/<run-id>_errors.csv       # per-row API failures (retryable)
Lead-Lists/2-Lead-Magic/<run-id>_progress.jsonl   # LeadMagic resume journal
Lead-Lists/3-Million-Verifier/<run-id>_merged.csv           # MV input (vayne + leadmagic emails, deduped)
Lead-Lists/3-Million-Verifier/<run-id>_merged.verified.csv  # all rows + email_status
Lead-Lists/4-Final-Lead-Lists/<run-id>_final.csv  # ★ ok-only send-ready list
Lead-Lists/4-Final-Lead-Lists/<run-id>_scorecard.md # quality grade for the final list
Lead-Lists/<run-id>.manifest.json                 # run state — enables resume
```

Canonical CSV columns (used at every stage):

```
company_domain, first_name, last_name, job_title, linkedin_url, email, email_source,
company_name, company_industry, company_headcount, company_phone, location, company_linkedin_url
```

`email_source` is `vayne` or `leadmagic`. The merged/final files add a trailing `leadmagic_status` column (LeadMagic's own opinion — informational only; MillionVerifier is the authority).

## The run manifest

Write `Lead-Lists/<run-id>.manifest.json` when the run starts and update it after EVERY
stage boundary. Shape:

```json
{
  "run_id": "saas-vp-sales-us_2026-07-22",
  "created_at": "<ISO timestamp>",
  "mode": "confirm-each-paid-step | fully-automatic",
  "icp_description": "...",
  "sales_nav_url": "...",
  "vayne":          { "status": "pending|running|done|failed", "estimate": 0, "order_id": "", "rows": 0, "rows_with_email": 0 },
  "leadmagic":      { "status": "pending|done", "attempted": 0, "found": 0, "no_email": 0, "errors": 0 },
  "millionverifier":{ "status": "pending|done", "mv_file_id": "", "ok": 0, "catch_all": 0, "invalid": 0, "unknown": 0 },
  "final":          { "rows": 0, "scorecard_grade": "" },
  "files": { "vayne_csv": "", "merged_csv": "", "final_csv": "", "scorecard": "" }
}
```

Record `order_id` the moment Vayne's `create_order` returns, and `mv_file_id` the moment
bulk-verify prints it — those two IDs are what make an interrupted run resumable without
re-spending.

## Flow

### Step 0: Preflight

1. Call `mcp__vayne__get_credits`. If the Vayne MCP tools aren't available, stop:
   the user must connect the Vayne MCP server first.
2. Check `.env` has `LEADMAGIC_API_KEY` and `MILLIONVERIFIER_API_KEY` (non-empty). If not, stop with instructions.
3. Scan `Lead-Lists/*.manifest.json` for any run whose stages aren't all `done`. If one
   exists, offer: **"Resume `<run-id>` from the <first-incomplete-stage> stage, or start fresh?"**
   Resume paths: Vayne incomplete → `mcp__vayne__get_order` with the saved `order_id`;
   LeadMagic incomplete → rerun `leadmagic-find-emails.ts` with `--resume`;
   MV incomplete → rerun bulk-verify with `--resume=<mv_file_id>`.

### Step 1: Run mode (ask FIRST, before any Vayne call)

```
How do you want to handle paid steps this run?

[A] Confirm each paid step — I pause with the cost + remaining credits before the
    Vayne order, before the LeadMagic batch, and before the MillionVerifier upload.
[B] Fully automatic — after you confirm the Sales Nav URL + estimate once, I run the
    whole pipeline with no further pauses (I still hard-stop if credits run out).
```

Record the choice in the manifest. **In BOTH modes, Step 3's URL + estimate confirmation
is mandatory** — mode B only removes the LeadMagic and MillionVerifier pauses.

### Step 2: Entry point

Ask what they're starting from (or infer it from their message):

- **(a) ICP description** ("VPs of Sales at US SaaS companies, 50-200 headcount") →
  use `mcp__vayne__search_locations` / `mcp__vayne__search_industries` to resolve filter
  IDs, then `mcp__vayne__build_search_url` (people search). Show the resulting URL AND
  its filters translated to plain English so the user can sanity-check. Then
  `mcp__vayne__estimate_search`.

  `build_search_url` gotchas (cost a failed call on 2026-07-22):
  - Every filter is an OBJECT with `include`/`exclude` arrays, and items are objects:
    `title: {include: ["CEO", "Founder"]}`,
    `regions: {include: [{geo_id: "103644278", name: "United States"}]}`,
    `industries: {include: [{id: "30", name: "Travel Arrangements"}]}`,
    `companyHeadcounts: {include: ["11-50", "51-200"]}` (band strings, not min/max).
  - `search_locations` often returns geo_ids with `null` names — that's a display
    quirk, the ids work. US = `103644278`.
  - LinkedIn's current taxonomy folded several industries together (e.g. "Leisure,
    Travel & Tourism" → "Travel Arrangements" id 30). If a lookup misses, search a
    shorter fragment before concluding it doesn't exist.
- **(b) Pasted Sales Navigator URL** → `mcp__vayne__estimate_search` on it directly.
- **(c) Existing CSV** ("I already have a Vayne export / a lead list") → normalize it into
  `Lead-Lists/1-Vayne/<run-id>_vayne.csv` (via `normalize-vayne.ts` if headers aren't
  canonical) and skip to Step 4. This is also the cheap way to test the pipeline.

Derive the run ID from the ICP/search (kebab-case, ≤40 chars, + today's date), create the
manifest.

### Step 3: Vayne scrape (paid — gated in BOTH modes)

1. Show: estimated lead count, scraping-credit cost, current **SCRAPING** credit balance
   and `daily_limit_leads` from `get_credits`. (Vayne has two pools — orders spend the
   SCRAPING pool; never quote the enrichment pool here.)
2. Edge cases before ordering:
   - Estimate **0** → don't order; iterate on the filters with the user.
   - Estimate **exceeds the daily lead limit** or looks oversized (e.g. >2,500 when the
     user wanted a focused list) → warn and offer to narrow the search first.
3. On explicit user confirmation → `mcp__vayne__create_order`. Write `order_id` to the
   manifest IMMEDIATELY.
4. Poll `mcp__vayne__get_order` — scale the interval to the order: ~1-2 min for small
   orders, every 10 min for 1,000+ leads (a 3,000-lead order took ~50 min on
   2026-07-22 at roughly 50-60 leads/min after a slow first few minutes). Tell the
   user it's running rather than spamming updates.
5. **Persist results:**
   - If the completed order exposes a results/download URL → download it with
     `curl -L -o "Lead-Lists/1-Vayne/<run-id>_vayne-raw.csv" "<url>"` (works for .json
     too), then:
     ```
     npx tsx .claude/skills/vayne-lead-pipeline/scripts/normalize-vayne.ts \
       --file=Lead-Lists/1-Vayne/<run-id>_vayne-raw.csv \
       --out=Lead-Lists/1-Vayne/<run-id>_vayne.csv
     ```
     `head -2` the raw file first and check the script's printed mapping report; if any
     column was mis-detected, rerun with an explicit `--map=canonical:source,...`.
   - If results only come back inline through the MCP tool → write
     `<run-id>_vayne.csv` yourself with the canonical header, appending in chunks of
     ~100 rows (never hold thousands of rows in a single write).
6. If the order fails or is canceled → surface Vayne's error verbatim, mark
   `vayne.status=failed` in the manifest, and NEVER re-order without explicit
   confirmation (credits may already be spent).
7. Report: rows scraped, how many already have emails (`email_source=vayne`), and update
   the manifest.

### Step 3.5: Trim + scrape registry (free — ALWAYS run before LeadMagic)

Vayne's `matching filters` flag over-fires (it re-checks against LinkedIn company-page
data, which is often blank or uses a different taxonomy) — do NOT drop rows on that
flag alone. Instead, inspect the actual `company_industry` / `company_headcount`
distribution, propose a trim to the user, then run:

```
npx tsx .claude/skills/vayne-lead-pipeline/scripts/trim-and-register.ts \
  --file=Lead-Lists/1-Vayne/<run-id>_vayne.csv \
  --run-id=<run-id> \
  --profile=profiles/<slug>/client-profile.yaml \
  --drop-headcounts="myself only,501-1000,1001-5000,5001-10000,10001+" \
  --drop-industries="<hard-out industries the user confirms>"
```

This does three things in one pass:
- drops the profile's `excluded_domains` + the user-confirmed headcount/industry bands
  (dropped rows go to `<run-id>_vayne-dropped.csv` with a `drop_reason` — never deleted);
- drops rows already scraped by a PREVIOUS run (via `Lead-Lists/scraped-registry.csv`),
  so re-running an overlapping search never re-spends LeadMagic/MV credits;
- registers every scraped profile in the registry for future runs.

Trim choices are explicit flags because soft edges are the user's call (the operator's
2026-07-22 run KEPT 2-10 and 201-500 bands and "Hospitality"-tagged rows). To avoid
re-scraping at the Vayne level too, partition follow-up searches into disjoint slices
(headcount band, state groups) — record the slicing in the manifest's `partition_note`.

### Step 4: LeadMagic email finding (paid — gated in mode A)

**⚠️ NEVER use `lm enrich` (bulk CLI) for email finding. This REVERSES the
2026-07-23 bulk-first preference, after the 2026-09-08 HVAC/roofing incident
(3,574 credits spent, zero output delivered on a ~2,090-row run):**

- `lm enrich` silently waterfalls email-finder → **mobile-finder (5 credits/hit)**
  on rows where email lookup doesn't immediately succeed. There is no email-only
  flag; `--skip-validation` does NOT prevent it. ~65% of the incident spend was
  phone numbers nobody asked for.
- The CLI's browser-session auth (`lm login`) **expires mid-run** on long jobs
  (~2.5h in) → 401 retry storms, failed records, but continued partial spend.
- Results are held **in memory only** and written at the very end — a kill or
  crash loses everything already paid for (its DuckDB audit log records costs,
  not emails). LeadMagic **re-charges repeat lookups**, so lost results are lost.
- Throughput was also terrible: ~14 rows/min (≈2.5h per 2,000 rows) vs the
  per-lead script's concurrency-10 direct API calls.

**Standard path — the per-lead script** (direct API via `LEADMAGIC_API_KEY`, no
browser session, per-row JSONL journal so nothing is ever lost or re-spent):

1. Always dry-run first (free):
   ```
   npx tsx .claude/skills/vayne-lead-pipeline/scripts/leadmagic-find-emails.ts \
     --file=Lead-Lists/1-Vayne/<run-id>_vayne.csv --dry-run
   ```
   This prints: how many rows already have emails, how many need lookup, how many are
   skipped (missing name or domain+company), and the LeadMagic credit balance.
   LeadMagic charges **1 credit per FOUND email, 0 per miss** — so the dry-run count is
   the worst-case cost.
2. **Mode A**: pause — "Up to N lookups ≈ N credits worst case; you have M. Proceed?"
   **Mode B**: proceed unless credits are obviously insufficient.
3. Run the real batch (same command minus `--dry-run`). The script writes the found /
   no-email / errors CSVs AND the merged MV input (`--out-merged` defaults handle the
   standard paths when the input follows the `<run-id>_vayne.csv` convention).
4. Edge cases:
   - **0 found** → check `<run-id>_errors.csv` FIRST: auth/credit failures mean fix and
     rerun with `--resume`; genuine all-miss usually means `company_domain` is empty
     across the list (check the normalize step's mapping). If Vayne-provided emails
     exist, continue with just those and say so plainly.
   - **Row errors > 0** → the summary splits them: RETRYABLE (network/5xx) → rerun the
     same command with `--resume` (journaled successes are never re-spent); PERMANENT
     (4xx, usually junk name fields) are journaled as permanent and will NOT retry —
     don't loop on them. The script pre-cleans names (quoted nicknames, taglines,
     business names in name columns) and skips unfixable ones as `invalid_name`.
5. Report hit rate + update manifest.

### Step 5: Merge

Done inside the LeadMagic script (`--out-merged`): Vayne-email rows + LeadMagic-found
rows, deduped by lowercase email (Vayne row wins a collision) then by linkedin_url.
Nothing to run — just report merged count and dupes removed from the script summary.

### Step 6: MillionVerifier (paid — gated in mode A)

1. **Mode A**: pause — "N unique emails to verify ≈ N MV credits. Proceed?" (bulk-verify
   also preflights credits itself and aborts if short). **Mode B**: proceed.
2. Run:
   ```
   npx tsx .claude/skills/millionverifier/scripts/bulk-verify.ts \
     --file=Lead-Lists/3-Million-Verifier/<run-id>_merged.csv \
     --keep=ok \
     --out-verified=Lead-Lists/3-Million-Verifier/<run-id>_merged.verified.csv \
     --out-send-ready=Lead-Lists/4-Final-Lead-Lists/<run-id>_final.csv
   ```
3. The script prints `file_id` on upload ("Resume with --resume=<id>") — copy it into the
   manifest immediately.
4. Edge cases:
   - **Timeout** → rerun with `--resume=<mv_file_id>` (no re-spend).
   - **Stall at 99%** → handled automatically: after 10 min with no progress past 99%
     the script finalizes the file via `/bulkapi/stop` (greylisted stragglers return
     unverified, which an ok-only list drops anyway). Tune with `--stall-minutes=N`,
     disable with `--stall-minutes=0`.
   - **catch_all-heavy** (script warns >25%) → explain the final list shrinks
     accordingly. The ok-only policy is the house standard — the skill NEVER loosens
     `--keep` on its own. If the user consciously wants catch-alls, they can manually
     rerun bulk-verify with `--keep=ok,catch_all` on the merged file.
   - **Final list tiny (<100 rows)** → warn it's below a useful campaign sample size;
     suggest broadening the ICP and running again.
5. Update manifest with the ok/catch_all/invalid/unknown counts.

### Step 7: Scorecard + wrap-up (free — runs in BOTH modes)

1. The final CSV has no `email_status` column (Instantly rejects extra columns), but the
   scorecard needs it to score verification coverage. So score a status-preserving copy
   of the same rows:
   ```
   npx tsx .claude/skills/vayne-lead-pipeline/scripts/filter-status.ts \
     --file=Lead-Lists/3-Million-Verifier/<run-id>_merged.verified.csv \
     --out=Lead-Lists/3-Million-Verifier/<run-id>_ok-with-status.csv

   npx tsx .claude/skills/list-quality-scorecard/scripts/score-list.ts \
     --list=Lead-Lists/3-Million-Verifier/<run-id>_ok-with-status.csv \
     --out=Lead-Lists/4-Final-Lead-Lists/<run-id>_scorecard.md
   ```
   If a `profiles/<slug>/client-profile.yaml` exists for this business, add
   `--icp-file=profiles/<slug>/client-profile.yaml` for the ICP-fit dimension.
2. Finalize the manifest (all stages `done`, scorecard grade recorded).
3. Print the run summary:

```
=== <run-id> — pipeline complete ===
Vayne scraped        NNN leads   (NN with emails)          → 1-Vayne/
LeadMagic found      NNN emails  (NN% hit rate)            → 2-Lead-Magic/
  no email found     NNN (kept: <run-id>_no-email.csv)
Merged for verify    NNN unique emails                     → 3-Million-Verifier/
MillionVerifier      ok NNN | catch_all NNN | invalid NNN | unknown NNN
FINAL LIST           NNN leads — Lead-Lists/4-Final-Lead-Lists/<run-id>_final.csv
Scorecard            grade X — <run-id>_scorecard.md
Credits spent        Vayne ~NNN scraping | LeadMagic NNN | MV NNN
```

## Safeguards

- **Never call `create_order` without explicit user confirmation** of the URL + estimate + cost — in BOTH modes. It's an irreversible spend.
- Always pull fresh balances via `get_credits` before quoting a cost; quote the SCRAPING pool for orders.
- Fully-automatic mode still hard-stops on insufficient credits at every paid stage (the scripts enforce this too).
- Never delete intermediates. The no-email CSV is a permanent record — those leads can be retried later with another finder.
- Update the manifest at every stage boundary so ANY interruption is resumable without re-spending.
- Final list policy is `ok` only. Do not loosen `--keep` unless the user explicitly asks.

## What to do next

- `/campaign-copywriting` — write the sequence for this list
- `/instantly-campaign-upload-public` — upload `<run-id>_final.csv` as a DRAFT campaign
- Optional: `/icp-prompt-builder` on a 50-row sample if you want AI company-fit qualification before sending

## Related skills

- `/millionverifier` — Step 6 runs its bulk-verify script; also has single-email checks
- `/list-quality-scorecard` — Step 7 runs its score-list script
- `/blitz-list-builder` — alternative when you start from a list of company domains
- `/instantly-campaign-upload-public` — downstream upload
- `/cold-email-kickoff` — upstream orchestrator for ICP/strategy before list building
