# Cold Email Claude Kit

A complete cold email operation you run by talking to [Claude Code](https://docs.anthropic.com/en/docs/claude-code).
Twenty-nine skills cover the full cycle: pick who to target, build and verify a lead list, write the
emails, upload them to **Instantly** and run the campaigns day to day. A few optional automations
are included too: a daily account manager, an AI reply drafter, and a "call this lead now" phone
finder.

Built and used in production by **Sundale Systems**. It extends the open-source
[GrowthEngineX](https://growthengine-x.com) cold-outbound skills pack (MIT). That pack was
converted to Instantly API v2, given a Sales Navigator → LeadMagic → MillionVerifier list
pipeline, and hardened by real campaigns. The lessons from those campaigns are in
[docs/lessons-learned.md](docs/lessons-learned.md).

> **No lead data, client data or API keys are in this repo.** You bring your own accounts and keys.

---

## What you can do with it

| You say to Claude… | What happens |
|---|---|
| `/cold-email-kickoff` | Guided start: interviews you about your business, defines your ideal customer (ICP), picks a free offer, and writes a campaign plan. |
| `/vayne-lead-pipeline` | Builds a lead list: scrapes a LinkedIn Sales Navigator search, finds work emails, verifies every one, and grades the final list. |
| `/campaign-copywriting` | Writes the email sequence step by step, checking direction with you at each stage. |
| `/spam-word-checker` | Flags words that hurt deliverability. It also runs automatically on any copy Claude writes. |
| `/instantly-campaign-upload-public` | Uploads leads + copy to Instantly as a **draft**. Nothing sends until you press Resume in Instantly. |
| `/positive-reply-scoring` | After ~21 days: tells you how many replies were actually positive, the number that matters. |
| `/experiment-design` | Plans the next test properly, one change at a time. |

The full list of skills is in [docs/roadmap.md](docs/roadmap.md) ("which skill do I use when?").

---

## Setup (about 30 minutes)

### 1. Install the tools
- **Claude Code**: https://docs.anthropic.com/en/docs/claude-code (a paid Claude plan is needed).
- **Node.js 20+**: https://nodejs.org. Then install the script runner once:
  ```bash
  npm install -g tsx
  ```
- **Git**: to download this repo.

### 2. Get the code
```bash
git clone https://github.com/SundaleSystems/cold-email-claude-kit.git
cd cold-email-claude-kit
```

### 3. Add your API keys
```bash
cp .env.example .env
```
Open `.env` and fill in **only what you'll use**. The minimum for a first campaign:

| Key | What it's for | Where to get it |
|---|---|---|
| `INSTANTLY_API_KEY` | Sending, campaigns, inboxes | Instantly → Settings → Integrations → API Keys (v2) |
| `LEADMAGIC_API_KEY` | Finding work emails | leadmagic.io → API |
| `MILLIONVERIFIER_API_KEY` | Verifying emails before you send | millionverifier.com → API |
| `SENDER_*` | Your name/title/company for signatures | you |

`.env` is git-ignored, so your keys never leave your machine. Check which keys work:
```bash
npx tsx .claude/skills/cold-email-starter-kit/scripts/verify-credentials.ts
```

### 4. Connect Vayne (for Sales Navigator lead lists)
Lead sourcing uses [Vayne](https://vayne.io) through its MCP server. Get an API token from
Vayne, then run this inside the repo folder:
```bash
claude mcp add --transport http vayne https://mcp.vayne.io/mcp --header "Authorization: Bearer YOUR_VAYNE_TOKEN"
```
Paste the token **without** angle brackets. `Bearer <token>` connects fine but then every call
fails with "Invalid token". Vayne has two separate credit pools (scraping vs enrichment); Claude
quotes the cost and asks before spending.

### 5. Start
```bash
claude
```
Then type `/cold-email-kickoff`. Claude reads `CLAUDE.md` and the skills automatically.

---

## The workflow

```
1. Strategy      /cold-email-kickoff → client-profile.yaml + campaign-plan.md (saved in profiles/)
2. Infrastructure /zapmail-domain-setup-public → /instantly-inbox-manager → wait 2 weeks for warmup
3. Lead list     /vayne-lead-pipeline   (Lead-Lists/1-Vayne → 2-Lead-Magic → 3-Million-Verifier → 4-Final-Lead-Lists)
4. Copy & send   /campaign-copywriting → /spam-word-checker → /instantly-spintax → /instantly-campaign-upload-public (DRAFT)
5. Run           /account-manager (optional daily automation) · /cold-email-weekly-rhythm
6. Learn         wait 21 days → /positive-reply-scoring → /experiment-design
```

**Never send cold email from your main business domain.** Buy lookalike domains (step 2) and
warm them up for two weeks first. `/cold-email-starter-kit` explains why, step by step.

---

## What's in the repo

| Path | What it is |
|---|---|
| `.claude/skills/` | The 29 skills. Each has a `SKILL.md` (instructions Claude follows) and sometimes `scripts/` and `references/`. |
| `docs/roadmap.md` | Which skill to use when. |
| `docs/lessons-learned.md` | **Read this before your first list build.** Credit traps, API gotchas, how big a test needs to be, reply templates. |
| `docs/scaling-to-1500-per-day.md` | Worked example: how many inboxes, leads and campaigns 1,500 emails/day takes. |
| `Lead-Lists/` | Where list builds write their CSVs, one folder per stage. Git-ignored. |
| `profiles/` | One folder per business you run campaigns for. Git-ignored. |
| `scripts/` | Extra pipelines: ICP qualification with Claude sub-agents, revenue filtering, campaign post-mortem analysis. |
| `account-manager/` | *Optional.* Daily job that checks Instantly, keeps campaigns live and sending at a target volume, and posts to Slack. Starts with every autonomy switch **off**. See its README. |
| `reply-gate/` | *Optional, advanced.* AI drafts replies to interested prospects, with safety checks and a shadow mode. Runs on Supabase. |
| `phone-hunt/` | *Optional, advanced.* When a prospect replies "interested", finds their mobile number and alerts you to call. Runs on Supabase. |
| `n8n/` | *Optional.* n8n workflows: Instantly → ClickUp CRM, and a positive-reply phone lookup. |
| `ui/` | *Optional.* Local chat page for talking to the account-manager and reply-gate agents (`npx tsx ui/server.ts`). |

---

## House rules baked into the skills

- **Uploads are always drafts.** You review and press Resume in Instantly. Only the account
  manager can activate campaigns, and only if you switch that on in its runbook.
- **Verify every email** and send only to "ok" results. Re-verify anything older than 30 days.
- **Personalization runs on Claude Code sub-agents**, not a separate paid AI API key.
- **One question mark per email**, and the call to action asks for a meeting.
- **Never use the LeadMagic bulk CLI (`lm enrich`)**. It quietly spends 5 credits per lead on
  phone lookups. Use the per-lead script the pipeline already calls.

---

## Costs to expect

The repo is free. The services aren't: Claude plan, Instantly plan, domains (~$10/yr each),
inboxes (Zapmail or similar), Vayne scraping credits, LeadMagic credits (~1 per email found) and
MillionVerifier credits. The skills quote credit costs and ask before
any paid action.

## License

MIT. See [LICENSE](LICENSE).
