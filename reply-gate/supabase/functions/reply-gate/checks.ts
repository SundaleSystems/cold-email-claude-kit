// Plain code goes first. Length, banned phrases, formatting, price
// leaks, wrong nouns, sign-off. Code is perfect at these and never has
// an opinion, so nothing that fails here reaches the verifier at all.
import type { CheckResult, Lead, OfferSheet } from "./types.ts";

// Generic business nouns a model reaches for when it guesses.
const GENERIC_NOUNS = [
  "shop", "store", "practice", "clinic", "firm", "agency",
  "studio", "salon", "office", "outfit", "operation", "venture", "startup",
];

export function runChecks(args: {
  finalBody: string;
  sheet: OfferSheet;
  globalFacts: string;
  lead: Lead;
}): CheckResult {
  const { finalBody, sheet, lead } = args;
  const failures: string[] = [];
  const detail: Record<string, boolean> = {};
  const lower = finalBody.toLowerCase();
  const sheetText = [
    sheet.original_pitch, sheet.offer_facts, sheet.pricing_facts, args.globalFacts,
    sheet.high_level_answer, sheet.lead_magnet, sheet.calendly_url,
    JSON.stringify(sheet.common_questions), JSON.stringify(sheet.ideal_replies),
  ].filter(Boolean).join("\n").toLowerCase();

  const check = (name: string, ok: boolean, why: string) => {
    detail[name] = ok;
    if (!ok) failures.push(why);
  };

  // 1. Length cap
  const words = finalBody.split(/\s+/).filter(Boolean).length;
  check("length", words <= sheet.max_words + 25, // sign-off + times allowance
    `Body is ${words} words; cap is ${sheet.max_words} (+25 for times/sign-off)`);

  // 2. Em-dashes and markdown read as machine-written in an email
  check("no_em_dash", !/[—–]/.test(finalBody), "Contains an em/en dash");
  check("no_markdown", !/(\*\*|__|^#{1,6}\s|^\s*[-*]\s|\[.+\]\(.+\))/m.test(finalBody), "Contains markdown formatting");

  // 3. No unresolved template placeholders
  check("no_placeholders", !/(\{\{|\}\}|\[(first.?name|company|name)\])/i.test(finalBody), "Contains an unresolved placeholder");

  // 4. Banned phrases from the offer sheet
  for (const phrase of sheet.banned_phrases ?? []) {
    check(`banned:${phrase}`, !lower.includes(phrase.toLowerCase()), `Contains banned phrase "${phrase}"`);
  }

  // 5. Price leak. Any dollar amount / price-like number must appear in
  //    the offer sheet; if the policy forbids pricing, none is allowed.
  const priceMatches = finalBody.match(/[$£€]\s?\d[\d,.]*k?|\b\d[\d,.]*\s?(dollars|usd|per month|\/mo|a month)\b/gi) ?? [];
  if (sheet.pricing_policy === "no_price_before_call") {
    check("no_price", priceMatches.length === 0, `Pricing policy forbids numbers, found: ${priceMatches.join(", ")}`);
  } else {
    for (const m of priceMatches) {
      check(`price_grounded:${m}`, sheetText.includes(m.toLowerCase().trim()),
        `Price "${m}" does not appear in the offer sheet`);
    }
  }

  // 6. Business noun. Any generic noun other than the declared one fails,
  //    unless that word genuinely appears in the lead's own company name
  //    or domain. Deterministic rule first; the verifier is the second
  //    layer, never the first.
  if (sheet.business_noun) {
    const leadOwnWords = `${lead.company_name ?? ""} ${lead.website ?? ""}`.toLowerCase();
    for (const noun of GENERIC_NOUNS) {
      if (noun === sheet.business_noun.toLowerCase()) continue;
      const re = new RegExp(`\\byour\\s+${noun}\\b|\\bthe\\s+${noun}\\b`, "i");
      if (re.test(finalBody) && !leadOwnWords.includes(noun)) {
        check(`noun:${noun}`, false, `Calls their business a "${noun}"; the declared word is "${sheet.business_noun}"`);
      }
    }
  }

  // 7. Sign-off is the sheet's sign-off (code appended it; belt and braces)
  const signoff = (sheet.sender_signoff ?? "").trim();
  if (signoff) {
    check("signoff", finalBody.trimEnd().endsWith(signoff), "Sign-off is missing or wrong");
  }

  // 8. Greeting uses their first name when we know it
  if (lead.first_name) {
    const first = lead.first_name.trim().split(/\s+/)[0];
    check("greeting", new RegExp(`\\b${escapeRe(first)}\\b`, "i").test(finalBody.slice(0, 80)),
      `Does not greet ${first} by name`);
  }

  // 9. No links except (optionally) a calendly link — cold reply bodies
  //    with random URLs trip spam filters and look templated.
  const urls = finalBody.match(/https?:\/\/\S+/gi) ?? [];
  for (const u of urls) {
    check(`url:${u}`, u.includes("calendly.com"), `Contains a URL that is not a Calendly link: ${u}`);
  }

  return { pass: failures.length === 0, failures, detail };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
