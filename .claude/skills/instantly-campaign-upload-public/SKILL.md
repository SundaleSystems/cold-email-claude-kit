---
name: instantly-campaign-upload-public
description: Upload a CSV of leads + a variants YAML (produced by /campaign-copywriting) to Instantly as a DRAFT campaign. Handles tag-scoped inbox selection, A/B/C variant assembly, custom variable mapping, schedule config, and batch lead upload. ALWAYS creates in DRAFT — you review in the Instantly UI and hit Resume/Launch manually. Use after /campaign-copywriting, just before the campaign goes live.
---

# Instantly Campaign Upload

Takes a `variants.yaml` (written by `/campaign-copywriting`) and a `leads.csv` (from your list-building skills) and creates a DRAFT campaign in Instantly. You review the result in the Instantly UI and press Resume/Launch manually.

**This skill does NOT ship any email copy.** Copy comes from `/campaign-copywriting`. This skill is the mechanical upload layer — API calls only.

## Why DRAFT only

Cold email launches should never happen from a script. Instantly creates every campaign in Draft (status 0), and this script never calls `/activate`. You hit Resume/Launch in the Instantly UI after reviewing:
- Subject lines + body previews
- Inbox assignments (correct tag? correct count?)
- Lead count and a few random lead rows
- Schedule (timezone + hours + throttle)

The script sets all of this up in DRAFT so the review is trivial — verify and click Resume/Launch.

## Inputs

### `leads.csv`

Required columns:
- `email`
- `first_name`
- `last_name`
- `company_name`

Optional columns (passed through to Instantly as `custom_variables`):
- `company_domain`
- `title`
- `linkedin_url`
- `situation_line` (AI-generated per-lead context)
- `value_line` (AI-generated value mapping)
- `cta_line` (AI-generated CTA angle)

Additional AI variable columns produced by `/campaign-copywriting` or `/personalization-subagent-pattern` — named fields only. The script does NOT accept arbitrary columns; this is intentional. If you need to add a field, update this skill.

### `variants.yaml`

Produced by `/campaign-copywriting`. Schema is in `references/variants-schema.yaml`.

Minimum required: `name`, `schedule`, `inbox_selection`, `sequences` with at least one step.

## Usage

```bash
export INSTANTLY_API_KEY=xxx
npx tsx scripts/upload.ts \
  --leads=profiles/<slug>/campaigns/<campaign-slug>/leads.csv \
  --variants=profiles/<slug>/campaigns/<campaign-slug>/variants.yaml
```

Output:
```
✓ Tag "active" resolved
✓ 20 inboxes selected (tag=active, LRU by 7-day sent volume)
✓ Campaign created (3 steps, 3 variants on step 1, M-F 08:00-17:00 EST, 30/day)
✓ 1,847 leads uploaded (2 batches)

Campaign is in DRAFT. Review + Launch:
→ https://app.instantly.ai/app/campaigns/<uuid>
```

## Script flow

1. Load env (`INSTANTLY_API_KEY` required)
2. Parse `leads.csv` — validate required columns, count rows
3. Parse `variants.yaml` — built-in minimal parser (~30 lines, no external dep)
4. Resolve inbox tag: `GET /api/v2/custom-tags?search=` → exact label match (case-insensitive)
5. `GET /api/v2/accounts?tag_ids=` (paginated) → filter to Active + fully set up, sort by 7-day sent volume ASC (LRU via `/api/v2/accounts/analytics/daily`), take top N
6. `POST /api/v2/campaigns` — ONE call with name, `email_list` (selected inbox emails), sequences (all A/B/C variants), schedule, and settings (tracking off, stop on reply)
7. Batch-upload leads (1000 per batch) via `POST /api/v2/leads/add` with CSV extras mapped to `custom_variables`
8. Print campaign URL. **Do NOT activate.**

## Gotchas

- **Tag must exist and be applied to inboxes first.** Use `/instantly-inbox-manager` to tag inboxes as `active` before running this upload.
- **Inbox count.** If `inbox_selection.count` exceeds tagged inboxes, the script selects all available and warns.
- **Leads CSV size.** Batches are 1000 leads per request (Instantly's `/leads/add` maximum). Tested up to 10K rows; larger runs may hit API rate limits. Script has built-in retry with exponential backoff.
- **Variants.yaml mismatch.** If `/campaign-copywriting` didn't produce the exact schema, the script fails fast with a clear error pointing at the offending field.
- **Email duplicates.** The upload passes `skip_if_in_campaign: true`, so Instantly skips leads already in any campaign in the workspace. Still, dedupe your CSV first with `/list-quality-scorecard`.

## What to do next

**Open the Instantly URL printed at the end. Review the campaign. Hit Resume/Launch when satisfied.** The script deliberately does not auto-activate.

After launch:
- Wait 21 days, then run `/positive-reply-scoring` on the campaign to measure.
- Every Monday: run `/email-deliverability-audit --days=7` (see `/cold-email-weekly-rhythm`).

**Or wait:** if the best-practice check flagged issues, go back to `/campaign-copywriting` and revise before uploading.

## Related skills

- `/campaign-copywriting` — produces `variants.yaml`
- `/instantly-inbox-manager` — required prep: inboxes must be tagged `active` before upload
- `/instantly-api` — canonical Instantly API v2 reference
- `/list-quality-scorecard` — dedupe + verify leads.csv before upload
- `/positive-reply-scoring` — run 21 days post-launch to measure
- `/cold-email-weekly-rhythm` — operational cadence after launch

## Files

- `scripts/upload.ts` — the upload script
- `references/variants-schema.yaml` — blank schema reference (no example copy content)
- `references/leads-csv-schema.md` — column spec
