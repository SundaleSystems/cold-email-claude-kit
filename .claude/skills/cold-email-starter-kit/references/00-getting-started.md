# 00 — Getting Started

Start here if you've never sent a cold email before. This file walks you through accounts, API keys, `.env` setup, cost, and your first verification.

---

## Is this for you? (3-question screener)

1. Do you have a product or service to sell?
2. Do you have ~$200 for the first month?
3. Do you have 60 minutes of focused time?

If yes to all three, keep reading.

---

## Technical prerequisites

### Node.js 20+
Check your version:
```bash
node --version
```
If it prints `v20.x.x` or higher, you're good. If not:
- **macOS**: `brew install node`
- **Linux**: use `nvm` (https://github.com/nvm-sh/nvm), then `nvm install 20`
- **Windows**: download installer from nodejs.org

### tsx (TypeScript runner)
```bash
npm install -g tsx
```
Verify: `tsx --version`

### A terminal
If you've never opened one: macOS Terminal.app, or Windows Terminal, or iTerm2.

### A text editor
Any will work. VS Code is free and recommended: https://code.visualstudio.com/

### Optional: `dig` for DNS verification
Already installed on macOS and most Linux. On Windows, install BIND utilities or use `nslookup` as a fallback.

---

## Accounts you need to create

### 1. Dynadot (domain registrar)
**What it does:** Buys throwaway domains for you programmatically.

**Signup:** https://www.dynadot.com/account/signup.html

**After signup:**
1. Top up your wallet with at least $100 (Tools → Account → Add Funds)
2. Go to **Tools → API**
3. Click "Enable API Access" and copy your API key
4. **Critical:** Whitelist your current IP address (find yours at https://whatismyip.com). Dynadot refuses API requests from un-whitelisted IPs.

### 2. Zapmail (inbox provider)
**What it does:** Hosts your sending inboxes, sets up SPF/DKIM/DMARC automatically, exports to Instantly.

**Signup:** https://zapmail.ai/

**After signup:**
1. Go to **Settings → API**
2. Copy your API token

### 3. LeadMagic (email finding — lead sourcing runs through the Vayne pipeline)
**What it does:** Finds work emails for leads scraped from Sales Navigator via Vayne.

**Signup:** https://leadmagic.io/

**After signup:**
1. Buy credits (used per email found)
2. Go to **Dashboard → API**
3. Copy your API key

### 4. Instantly (sending platform)
**What it does:** Sends your campaigns, rotates inboxes, runs warmup, and collects replies in one unified inbox (Unibox).

**Signup:** https://app.instantly.ai/signup
- 14-day free trial
- Growth plan ~$37/mo for 1,000 leads
- API key: **Settings → Integrations → API Keys → Create**

### 5. Optional enrichment APIs

Skip these for your first campaign. Add them later when you want personalization.

| Service | Purpose | Signup |
|---|---|---|
| Blitz | Company phone finder | https://blitz.us/ |
| OpenRouter | LLM API for AI company analysis | https://openrouter.ai/ |
| RapidAPI | Hub for LinkedIn scraper, OpenWebNinja | https://rapidapi.com/ |

---

## Real cost breakdown — first campaign

| Item | Provider | Cost | Notes |
|---|---|---|---|
| 20 × `.info` domains | Dynadot | $60 (20 × $3) | Cheapest TLD that still delivers |
| Domain privacy | Dynadot | $0 | Free on most TLDs |
| Zapmail inbox hosting | Zapmail | ~$38 | 40 inboxes × ~$0.95/mo |
| Instantly Growth | Instantly | $37/mo | 1K leads, upgrade for more |
| LeadMagic credits | LeadMagic | pay-as-you-go | charged per email found |
| **Total month 1** | | **~$186** | |
| **Recurring (month 2+)** | | **~$126/mo** | Domains are paid annually |

Optional enrichment (add later if needed):
- Blitz API: $50/mo small tier
- OpenRouter GPT-4o-mini: ~$0.15 per 1,000 leads enriched
- OpenWebNinja via RapidAPI: $10-25/mo
- RapidAPI LinkedIn Bulk Scraper: $25-75/mo

**Realistic month-1 total with light enrichment: ~$250.**

---

## Setting up the `.env` file

In the skill root, copy the template:

```bash
cd <repo>/skills/cold-email-starter-kit
cp .env.example .env   # or create .env manually
```

Open `.env` in your editor and fill in the keys you just collected:

```env
# ── Domain registrar ─────────────
DYNADOT_API_KEY=

# ── Inbox provider ───────────────
ZAPMAIL_API_KEY=

# ── List building ────────────────
LEADMAGIC_API_KEY=

# ── Sending platform (required) ──
INSTANTLY_API_KEY=

# ── Enrichment (optional, leave blank for now) ────
BLITZ_API_KEY=
BLITZ_BASE_URL=https://api.blitz.us
OPENROUTER_API_KEY=
RAPIDAPI_KEY=

# ── Your sending identity ────────
SENDER_FIRST_NAME=Jane
SENDER_LAST_NAME=Doe
SENDER_EMAIL_PREFIX_1=jane
SENDER_EMAIL_PREFIX_2=janedoe
DEFAULT_REPLY_TO_EMAIL=jane@yourmaindomain.com

# ── Physical address (for email footer — recommended) ────
COMPANY_STREET=123 Main St
COMPANY_CITY=Anytown
COMPANY_STATE=CA
COMPANY_ZIP=94105
COMPANY_COUNTRY=USA
```

**NEVER commit `.env` to git.** If you're in a git repo, add `.env` to `.gitignore` immediately.

---

## Verify your setup

From the skill root:
```bash
npx tsx scripts/verify-credentials.ts
```

Expected output:
```
Service       Status  Notes
Dynadot       ✅      Wallet: $127.50
Zapmail       ✅      0 domains, 0 inboxes
LeadMagic     ✅      Credits: 1000
Instantly     ✅      Workspace: My Workspace
```

If any row is ❌:
- **Dynadot**: Is your IP whitelisted? Check https://whatismyip.com vs Dynadot Tools → API settings
- **Zapmail**: Verify the token in Settings → API
- **LeadMagic**: Confirm credits are loaded, try regenerating the key
- **Instantly**: `INSTANTLY_API_KEY` is required for sending — generate a v2 key under Settings → Integrations → API Keys

Once everything is green, you're ready to launch your first campaign. Open `references/14-60-minute-tutorial.md` for the step-by-step walkthrough, or `references/01-deliverability-fundamentals.md` if you want to understand why we're doing all of this first.

---

## Your first "hello world"

Before spending any money, try a zero-cost test:

```bash
npx tsx scripts/dynadot-generate-domains.ts --brand test --count 10 --check-only
```

This generates 10 candidate domain names and checks Dynadot for availability. No purchase. If you see a list with prices, everything's wired correctly.
