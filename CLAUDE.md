# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A cold email operations workspace built around 29 Claude Code skills covering ICP definition, lead
sourcing, enrichment, verification, copywriting, and sending via **Instantly.ai**. There is no
application to build. The "product" is the skills plus the lead-list pipeline they produce. Skills
live in `.claude/skills/<name>/` (SKILL.md + optional `scripts/` and `references/`).

The user may be new to cold email. Explain the next step in plain terms, recommend a skill from
`docs/roadmap.md` rather than improvising, and point them to `docs/lessons-learned.md` before
their first list build.

## Conventions

- **Instantly-only.** All skills and scripts use the Instantly API v2 (`/instantly-api` is the endpoint reference). Any SmartLead reference is stale; rewrite it for Instantly.
- **Canonical list build = `/vayne-lead-pipeline`**: Vayne (Sales Navigator via MCP) → LeadMagic email finding → MillionVerifier ok-only filter → scorecard. It bundles `/icp-prompt-builder`, verification, and `/list-quality-scorecard` end to end.
- **Lead-list artifacts** go through `Lead-Lists/` stage folders: `1-Vayne/` → `2-Lead-Magic/` → `3-Million-Verifier/` → `4-Final-Lead-Lists/`. Write each stage's CSV to its matching folder. Client strategy files go in `profiles/<client>/`. Both are git-ignored; never commit lead or client data.
- **Campaign uploads are always DRAFT.** `/instantly-campaign-upload-public` never launches; the user hits Resume in the Instantly UI. **One exception:** the `/account-manager` daily run (`account-manager/scripts/daily.ts`) may activate, pause, clone, and top up campaigns, but only for a client whose `account-manager/clients/<client>/runbook.json` sets the matching `autonomy.*` switch to `true`. The example runbook ships with every switch off.
- **Personalization and ICP qualification use Claude Code Task sub-agents**, never an external Anthropic/OpenAI API key (see `personalization-subagent-pattern` and `icp-prompt-builder`).
- **Paid actions need confirmation.** Quote the credit cost (Vayne, LeadMagic, MillionVerifier) and get a yes before spending.

## Commands

Scripts are TypeScript run directly with `tsx` (install globally with `npm i -g tsx`; there's no package.json). `_lib.ts` in each skill's `scripts/` handles .env loading and shared helpers with zero dependencies:

```bash
npx tsx .claude/skills/<skill>/scripts/<script>.ts                          # run any skill script
npx tsx .claude/skills/cold-email-starter-kit/scripts/verify-credentials.ts  # check which API keys work
```

There is no build, lint, or test suite. Verification is operational: run the script against the live API (use `--dry-run`/`--dry` first where offered) and check the output CSV/report.

API keys live in the root `.env` (copy `.env.example`). Sender identity vars `SENDER_*` are required by signature/upload scripts. For LeadMagic email finding, ALWAYS use the per-lead script (`.claude/skills/vayne-lead-pipeline/scripts/leadmagic-find-emails.ts`, direct API via `LEADMAGIC_API_KEY`), NEVER `lm enrich`. The bulk CLI silently runs 5-credit mobile-finder fallbacks, its session auth expires mid-run, and it loses all results if interrupted (see `docs/lessons-learned.md`).

## Architecture / how the skills compose

The full flow is mapped in `docs/roadmap.md` (read it before recommending a skill). Short version:

1. Strategy: `/cold-email-kickoff` orchestrates `/icp-onboarding` → `/lead-magnet-brainstorm` → `/campaign-strategy`; output is `profiles/<client>/client-profile.yaml` + `campaign-plan.md`, which downstream skills read.
2. Infra: `/zapmail-domain-setup-public` (Dynadot domains → Zapmail inboxes) → `/instantly-inbox-manager` (warmup, signatures, active/insurance tags) → 2-week warmup wait.
3. Lists: `/vayne-lead-pipeline` (preferred) or the other list builders, each requiring `/icp-prompt-builder`; always `/millionverifier` then `/list-quality-scorecard` before upload.
4. Copy & send: `/campaign-copywriting` → `/spam-word-checker` (auto-applies to all outbound copy) → `/instantly-spintax` → `/instantly-campaign-upload-public` (DRAFT).
5. Run: `/account-manager` checks the Instantly account daily (optional launchd job at 07:30), keeps a campaign live and sending at or above the runbook floor, escalates to Slack; see `account-manager/README.md`.
6. Iterate: 21-day wait → `/positive-reply-scoring` (north-star metric) → `/experiment-design` (single-variable, ~2,500 sends per arm) → `/cold-email-weekly-rhythm` cadence.

Optional advanced systems: `reply-gate/` (AI reply drafting on Supabase, shadow mode by default) and `phone-hunt/` (positive reply → mobile number lookup → alert). Each has its own README and `secrets.example`.

The Vayne MCP server provides LinkedIn scraping tools (`mcp__vayne__*`). It has separate scraping and enrichment credit pools; quote the cost and get confirmation before paid actions.
