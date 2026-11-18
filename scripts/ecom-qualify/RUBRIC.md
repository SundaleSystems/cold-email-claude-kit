# Qualification rubric — DTC e-commerce brands, $1–8M revenue (US)

## What you are judging

You are qualifying companies against an Ideal Customer Profile. There is **no seller
context here** — you are not asking "would they buy product X". You are asking only
whether the company matches the ICP shape below.

## The ICP

| Filter | Criteria |
|---|---|
| Business type | E-commerce brand |
| Revenue | $1M – $8M/year |
| Team | Small internal growth team |
| Trigger/pain | Active need for 15–100 pieces of new content per month |

## The one question that decides fit

> Is this an **e-commerce brand that sells its own products direct to consumers
> online**, at roughly **$1M–$8M in annual revenue**, run by a **small internal team**?

"Brand" is load-bearing. The ICP is a company that **owns the product it sells**.
A store that resells other people's brands, a marketplace, an agency that serves
e-commerce clients, or a software vendor selling to e-commerce companies are all
non-fits **no matter how well they match the industry and title filters**. The whole
point of this pass is to strip out companies that survive a spreadsheet filter but
are the wrong shape.

## What you are given per company

- `revenue_range` — LinkedIn's own revenue band. **Present on roughly 60% of rows.**
  When present it is the strongest single piece of evidence; trust it over your
  impression of the company's size.
- `li_description` — the LinkedIn company "About" text. Your primary evidence.
- `li_specialities` — comma-separated product/category tags.
- `li_industry`, `company_headcount`, `li_employees`, `li_founded`, `location`.
- `job_title` — the contact's title. **Do not judge the company by it.**

## Tiers

**Tier A — perfect.** Confirmed DTC e-commerce brand selling its **own** products
online to consumers, revenue band `1M USD - 2.5M USD` or `2.5M USD - 5M USD`,
headcount 11–50.
Shape: apparel/beauty/supplement/food/home-goods brands with an own-brand online
store. Description says things like "we make", "our products", "shop our", "founded
to create", names its own product lines.

**Tier B — strong.** Same DTC shape, but one of:
- `revenue_range` is **blank** and the description clearly establishes an own-brand
  consumer e-commerce business at a fitting headcount, **or**
- `revenue_range` is `5M USD - 10M USD` — straddles the $8M ceiling, so it is a
  probable but unconfirmed fit.

**Tier C — weak / unverifiable.** Any of:
- `li_description` is blank or too thin to establish the business model
- Consumer retail but plausibly brick-and-mortar-first (a shop, a boutique, a chain)
  with no evidence of a meaningful online channel
- Hybrid: sells some own-brand product but mostly resells others
- You could not establish enough to be confident

**Tier D — non-fit. Drop entirely.**
- **Agencies and service providers** — marketing, creative, branding, dev, 3PL,
  fulfillment, "we help e-commerce brands…". Very common in this list; be strict.
- **B2B / wholesale-only** — sells to retailers or businesses, not consumers
- **SaaS / software / platforms** selling *to* e-commerce companies
- **Marketplaces and aggregators** — sells other people's inventory
- **Pure resellers / dropshippers / distributors** — does not own the brand
- **Brick-and-mortar-only retail** with no online commerce
- Consultancies, media/blogs/influencers, non-profits, associations
- Non-US companies

## Hard rules

- **Judge the company, not the contact's job title.** Title weighting is applied later.
- **Never assign Tier A or B without concrete evidence** in the description or
  specialities. Quote it.
- **`evidence` must be a short verbatim quote** from `li_description` or
  `li_specialities` — not your paraphrase. If both are blank, `evidence` is `""`
  and the tier is **C with `confidence: low`**. Never A or B on a blank description.
- **Do not infer revenue from vibes.** If `revenue_range` is present, `revenue_basis`
  is `"linkedin_band"`. If blank, it is `"headcount_proxy"` and the tier caps at B.
- **Do not speculate about advertising spend or content volume.** Those criteria are
  not being evaluated in this pass and no field here speaks to them. Leave them alone.
- An "e-commerce" label in `li_industry` is **not** sufficient evidence of a DTC brand —
  agencies and B2B vendors self-code into retail industries constantly. Read the
  description.

## Output

Return **only** a JSON array, one object per company, in the same order as the input,
with exactly these keys:

```json
[{
  "domain": "example.com",
  "fit_tier": "A|B|C|D",
  "confidence": "high|med|low",
  "is_dtc_ecommerce": "yes|no|unclear",
  "revenue_basis": "linkedin_band|headcount_proxy|unknown",
  "est_team_shape": "small_internal|larger_team|unclear",
  "fit_reason": "max 25 words",
  "evidence": "short verbatim quote from li_description or li_specialities"
}]
```
