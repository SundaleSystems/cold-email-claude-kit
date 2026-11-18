# Qualification rubric — Sundale Systems ICP

## Who is selling, and what

**Sundale Systems** sells a **competitor price & promotion monitoring system for online travel companies**. It scrapes competitor websites and compares their prices and promotions against yours, in near-real-time. Built and proven in production for **CruiseDirect.com**, a cruise reseller.

The lead magnet is a **free competitor price snapshot**: their prices/promos vs 2–3 *named* competitors.

## The one question that decides fit

> Would a competitor price/promo monitor produce anything this company could act on?

That requires **both**:
1. The company **publishes prices online** that a scraper can read (a real number a consumer sees without talking to anyone), **and**
2. It has **competitors selling comparable inventory** — so a price comparison is meaningful.

A company that quotes bespoke trips privately has no prices to monitor and no like-for-like competitor. It is a non-fit **no matter how well it matches the job title and industry filters**. Be strict about this — the whole point of this exercise is to strip out the companies that pass a spreadsheet filter but could never buy.

## Tiers

**Tier A — perfect.** Sells *resold / commoditised* travel inventory online at published prices, usually with visible deals/promos. Direct price comparison against named rivals is trivial. This is the CruiseDirect shape.
Examples of the shape: cruise resellers; OTAs; flight/hotel booking sites; vacation-package sellers; tour marketplaces/aggregators; activity & excursion resellers; vacation-rental booking sites; ticket/pass resellers.
Signal: same product available from other sellers, prices shown in a searchable catalogue, "deals", "save $", "book now".

**Tier B — strong.** Sells its **own** packaged trips online at published per-person prices, in a category where competing operators offer comparable trips. Prospects can and do price-shop it against rivals.
Examples of the shape: adventure/group tour operators, rail/safari/expedition package sellers, multi-day guided tour companies with a public trip catalogue and per-trip prices.
Reference case: `under30experiences.com` — full public trip catalogue with prices and a "LAST MINUTE DEALS" section → **Tier B**.

**Tier C — weak.** Prices are published but the product is unique/niche with no real comparable set, OR the model is hybrid (some prices shown, mostly quote-driven), OR you could not verify enough to be confident.
Examples: single-property experiences, one-off charters, semi-custom operators, companies whose site you could not read.

**Tier D — non-fit.** Drop entirely.
- Quote-only / bespoke / luxury custom travel design ("tailor-made", "let's plan together", "request a quote", no prices anywhere). Reference case: `embarkbeyond.com` → **Tier D**.
- Corporate / business / incentive travel management (contract pricing, invisible to scrapers)
- B2B travel technology, SaaS, booking engines, host agencies / agent networks (they sell to agents, not travellers)
- Destination marketing orgs, tourism boards, convention & visitors bureaus
- Associations, non-profits, media/blogs/influencers, events companies
- Hotels, resorts, airlines, cruise lines *themselves* (they are the supplier, not a reseller comparing prices)
- Ground transport (limo, bus charter, shuttle), and anything not actually travel

## Search-driven pricing counts as published pricing

CruiseDirect itself shows no prices on its homepage — you pick a destination and dates, and the engine returns prices. **A public search/booking engine that returns real prices without a login is published pricing**, and it is the single best fit for this product.

So set `publishes_prices: "yes"` when the site has a working consumer search/booking flow — a date picker, a "search cruises / find flights / check availability / book now" widget, a results grid, an availability calendar — even if no dollar figure appears in the scraped homepage text. Scraped text is often just navigation, so absence of `$` is weak evidence on its own.

Only use `publishes_prices: "no"` when the path to a number is **a human**: "request a quote", "contact us for pricing", "let's plan your trip", a contact form, or a login wall.

## Hard rules

- If `site_status` is not `ok`, the site text is missing or unusable. **Use WebFetch on `https://<domain>` first.** If that also fails, WebFetch the company's LinkedIn page or run one WebSearch on the company name. If you still cannot establish the business model, assign **Tier C with `confidence: low`** — never Tier A or B on an unverified company.
- Never assign Tier A or B without concrete evidence of published prices. Quote the evidence.
- `named_competitors` must be **real, specific, named US companies** that sell comparable inventory (e.g. "Vacations To Go", "Expedia Cruises", "Viator"). Not categories, not "other OTAs". If you genuinely cannot name 2, that is strong evidence the company is not Tier A/B — downgrade it.
- Judge the **company**, not the contact's job title. Title weighting is applied later.
- `evidence` must be a short verbatim quote from the site (or the source you fetched), not your paraphrase.

## Output

Return **only** a JSON array, one object per company, same order as the input, with exactly these keys:

```json
[{
  "domain": "example.com",
  "fit_tier": "A|B|C|D",
  "confidence": "high|med|low",
  "business_model": "reseller_ota|own_packaged_trips|bespoke_agency|corporate_travel|b2b_software|dmo|transport|supplier_direct|other_nonfit",
  "publishes_prices": "yes|no|partial",
  "promo_activity": "yes|no",
  "named_competitors": ["Competitor One", "Competitor Two"],
  "fit_reason": "max 25 words",
  "evidence": "short verbatim quote from their site"
}]
```
