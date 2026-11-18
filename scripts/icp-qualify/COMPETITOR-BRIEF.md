# Competitor research brief

## Why this matters

Sundale Systems sells competitor price & promotion monitoring to online travel companies. Its lead magnet is a **free competitor price snapshot: your prices and promos vs 2–3 named competitors.**

The two names you produce go **directly into a cold email to that company's founder**. So:

> "Want to see how your cruise prices stack up against Vacations To Go and CruiseDirect?"

If the two names are right, the founder feels understood and replies. If they are generic or wrong, the email reads as automated spam and the lead is burned. A *wrong* name is worse than a boring one.

## What counts as the right competitor

You are looking for the **two closest comparable rivals** — NOT the two biggest companies in travel.

Apply these in priority order:

1. **Comparable inventory.** Sells the same kind of product a shopper would genuinely cross-shop. A cruise reseller competes with other cruise resellers; a Hawaii snorkel-tour operator competes with other Hawaii boat-tour operators — not with Expedia.
2. **Similar scale.** A peer, not a giant. Only name a giant (Expedia, Booking.com, Viator, Costco Travel) when it truly is that company's main day-to-day rival, which is rare for a small operator.
3. **Publicly priced.** Its prices must be visible online (listed, or returned by a public search/booking engine), otherwise a price snapshot is impossible and the name is useless.
4. **Same market reach.** Serves broadly the same customers, US-reachable.
5. **Genuinely a different company.** Never the lead company itself, its parent, its subsidiary, a rebrand of it, or a supplier whose inventory it resells.

**Same niche beats same size beats same category.** A regional Alaska cruise-tour operator's best competitors are other Alaska cruise-tour operators, even small ones.

## Treat the first-pass guess with suspicion

Each company includes `first_pass_guess` — competitor names a previous agent produced *while judging ICP fit*, not while researching competitors. They are frequently lazy defaults like "Expedia; Booking.com". Confirm or overturn them. **Actively reject a generic giant when a closer peer exists.** If you keep a guessed name, it must be because you verified it is genuinely the closest rival.

## How to research

For each company:
1. WebFetch `https://<domain>` to confirm what it actually sells, its niche, and its scale.
2. WebSearch — try several angles: `"<company> vs"`, `"<company> competitors"`, `"alternatives to <company>"`, and a category search like `"best <niche> companies <region>"`.
3. **Verify each candidate is real and still trading by fetching its website.** Do not trust a listicle alone — SEO spam invents companies and lists dead ones.

## Naming rule (strict)

Write each competitor **exactly as it brands itself**:

- Brand *is* a domain → keep the domain: `Booking.com`, `Hotels.com`, `Cruise.com`, `Rentalcars.com`, `Golfbreaks.com`
- Brand is a name → keep the name: `Vacations To Go`, `Costco Travel`, `Backroads`, `G Adventures`
- **Never convert between the two.** Not `vacationstogo.com`. Not `Booking`.
- No URLs, no `www.`, no `https://`, no trailing slash, no `, Inc.` / `LLC`.

Check the competitor's own site header/logo to see which form it uses.

## Output

Write a JSON array, one object per company, in the same order as the input:

```json
[{
  "domain": "leadcompany.com",
  "Competitor-1": "Vacations To Go",
  "competitor_1_why": "max 15 words - why this is the closest rival",
  "competitor_1_url": "https://vacationstogo.com",
  "Competitor-2": "CruiseDirect",
  "competitor_2_why": "max 15 words",
  "competitor_2_url": "https://cruisedirect.com",
  "changed_from_guess": true
}]
```

Both competitors are required for every company. If you genuinely cannot find two close peers, widen to the nearest category player rather than leaving a blank — but say so in the `why`.
