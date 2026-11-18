---
name: millionverifier
description: Bulk email verification via MillionVerifier. Upload any leads CSV, verify every email through the MV Bulk API (upload → poll → download), and get back a merged CSV with an email_status column plus a filtered send-ready CSV for Instantly. Also does single-email real-time checks and credit balance lookups. Use whenever the user says "verify emails", "bulk verify", "validate my list", "clean my list", "check for bounces before sending", "million verifier", "millionverifier", or when any list-building/enrichment skill outputs emails that haven't been verified yet. Run after list building and enrichment, BEFORE /list-quality-scorecard and /instantly-campaign-upload-public.
---

# MillionVerifier — Bulk Email Verification

Unverified emails bounce, and bounces burn domains. This skill runs any leads CSV through MillionVerifier's Bulk API and splits the safe-to-send emails from the risky ones — the mandatory step between building a list and uploading it to Instantly.

## Why this exists

Every list source in this repo (Vayne, DiscoLike, Blitz, Google Maps, LeadMagic) can emit emails that are dead, catch-all, or disposable. `/list-quality-scorecard` *checks* for a verification column; this skill *produces* it. The auto-research skill verifies one email at a time, which is fine for 50 leads — for a 5,000-row export you want one bulk upload, not 5,000 requests.

## Prerequisites

- [ ] `MILLIONVERIFIER_API_KEY` in the repo-root `.env` (see `.env.example` — key lives at https://app.millionverifier.com/api)
- [ ] Enough credits: 1 credit per unique email (check with `--credits`)
- [ ] A CSV with an email column

**Demo key:** `MILLIONVERIFIER_API_KEY=API_KEY_FOR_TEST` works on the **Single API only** (returns RANDOM results — good for testing `single-verify.ts`, useless for real data). The Bulk API rejects it with `invalid_api_key`, so `bulk-verify.ts` always needs a real key.

## Inputs

Any CSV with an email column (default column name `email`, override with `--email-col=`). All other columns pass through untouched.

## Output

Two files next to your input (paths overridable):

| File | Contents | Feeds into |
|---|---|---|
| `<input>.verified.csv` | ALL rows + new `email_status` column (`ok` / `catch_all` / `unknown` / `invalid` / `disposable`) | `/list-quality-scorecard` (it reads `email_status`) |
| `<input>.send-ready.csv` | Only rows whose status is in `--keep` (default `ok`), with `email_status` removed | `/instantly-campaign-upload-public` (its column allowlist rejects extra columns, so the status column is dropped) |

## Usage

Bulk verify (the main flow):

```bash
npx tsx skills/millionverifier/scripts/bulk-verify.ts --file=leads.csv
```

Common variants:

```bash
# keep catch-alls too (bigger list, higher bounce risk)
npx tsx skills/millionverifier/scripts/bulk-verify.ts --file=leads.csv --keep=ok,catch_all

# email column named differently
npx tsx skills/millionverifier/scripts/bulk-verify.ts --file=leads.csv --email-col=work_email

# recover an interrupted run (file_id is printed at upload time)
npx tsx skills/millionverifier/scripts/bulk-verify.ts --file=leads.csv --resume=940

# remove the uploaded file from MV servers after download
npx tsx skills/millionverifier/scripts/bulk-verify.ts --file=leads.csv --delete-remote
```

Single email / credits:

```bash
npx tsx skills/millionverifier/scripts/single-verify.ts --email=jane@acme.com
npx tsx skills/millionverifier/scripts/single-verify.ts --email=a@x.com,b@y.com
npx tsx skills/millionverifier/scripts/single-verify.ts --credits
```

## What the statuses mean (and what to do)

| Status | Meaning | Cold email decision |
|---|---|---|
| `ok` | Mailbox exists and accepts mail | **Send.** |
| `catch_all` | Domain accepts everything — mailbox can't be confirmed | Risky. Default is to exclude; include via `--keep=ok,catch_all` when volume matters more than bounce rate. Keep catch-all share of what you send under ~25%. |
| `unknown` | Server didn't give a definitive answer | Don't send. Re-verify later or drop. |
| `invalid` | Mailbox does not exist | **Never send.** Guaranteed bounce. |
| `disposable` | Temporary/burner address | **Never send.** |

The single API also returns `quality` (good/bad/risky), `free` (Gmail/Yahoo-type domain), `role` (admin@/sales@-type address — poor cold email targets), and `didyoumean` typo suggestions.

## Example output

```
[MV] 2147 rows, 2098 unique emails in "email".
[MV] Credits available: 24500 (plan: 3)
[MV] Uploaded as file_id=1882 (2098 unique emails, ~180s estimated). Resume with --resume=1882 if interrupted.
[MV] in_progress 46% — ok:801 catch_all:112 invalid:44 unknown:9 disposable:2
[MV] Downloaded 2098 results.

=== MillionVerifier bulk results ===
  ok            1743  (81.2%)
  catch_all      241  (11.2%)
  unknown         38  (1.8%)
  invalid        108  (5.0%)
  disposable       9  (0.4%)
  credits used: 2098

Wrote leads.verified.csv (2147 rows + email_status — feed to /list-quality-scorecard)
Wrote leads.send-ready.csv (1751 rows kept [ok] — ready for /instantly-campaign-upload-public)
```

## When to use

- AFTER any list-building or enrichment skill (`/vayne-lead-pipeline`, `/blitz-list-builder`, `/disco-like`, `/google-maps-list-builder`, `/email-waterfall`)
- BEFORE `/list-quality-scorecard` and `/instantly-campaign-upload-public`
- When bounce rate spikes on an existing campaign — re-verify the remaining list (`/deliverability-incident-response` will point you here)

## When NOT to use

- Inside `/auto-research-public` — its enrich phase already verifies its own (small) batches
- On a list you verified in the last ~30 days that hasn't changed
- For guessing/finding emails — this validates existing addresses; use `/email-waterfall` or LeadMagic to find them

## Scripts

- `scripts/bulk-verify.ts` — the main pipeline: preflight credits → upload → poll every 15s → download → merge + split outputs
- `scripts/single-verify.ts` — real-time check for one or a few emails, and `--credits` balance lookup

## References

- `references/api-reference.md` — the complete MillionVerifier API surface (all endpoints, params, enums, response shapes, error cases), extracted from the official OpenAPI spec at https://developer.millionverifier.com

## What to do next

1. Run `/list-quality-scorecard` on the `.verified.csv` — verification is its heaviest-weighted dimension. Note it counts only `email_status=ok` rows as verified, so this scores your raw list source (a low score = the source produced lots of bad emails, not that you'll bounce — you're only sending the send-ready file)
2. If the grade is ≥ B, proceed to `/campaign-copywriting` → `/instantly-campaign-upload-public` with the `.send-ready.csv`
3. If a lot of emails came back invalid (>10%), the list source is the problem — tighten filters before buying more data

## Related skills

- `/list-quality-scorecard` — reads the `email_status` column this skill writes
- `/instantly-campaign-upload-public` — consumes the send-ready CSV
- `/email-waterfall` — finds emails; this skill validates them
- `/deliverability-incident-response` — sends you here when bounce rate spikes
