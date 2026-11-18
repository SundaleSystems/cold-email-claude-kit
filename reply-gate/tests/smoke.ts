// Smoke tests for the deterministic layers (no network, no secrets).
// Run: deno run --allow-read --allow-env tests/smoke.ts (any dummy env values)
import { classifyNoise, detectSchedulingLink, stripQuoted } from "../supabase/functions/reply-gate/noise.ts";
import { runChecks } from "../supabase/functions/reply-gate/checks.ts";
import { assembleReply, bucketNeedsSlots } from "../supabase/functions/reply-gate/drafter.ts";
import type { OfferSheet } from "../supabase/functions/reply-gate/types.ts";

let failures = 0;
function t(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

const mkReply = (text: string, subject = "Re: quick question", isAuto = false) => ({
  id: "x", subject, text, eaccount: "sender@yourcompany.example", campaignId: "c", leadEmail: "a@b.com", isAutoReply: isAuto,
});

// --- noise ---
t("OOO skipped", classifyNoise(mkReply("I am out of the office until Monday")) !== null);
t("auto-reply flag skipped", classifyNoise(mkReply("anything", "Re: x", true)) !== null);
t("bounce skipped", classifyNoise(mkReply("Delivery has failed to these recipients")) !== null);
t("unsubscribe skipped", classifyNoise(mkReply("please remove me from your list")) !== null);
t("interested NOT skipped", classifyNoise(mkReply("Sounds interesting, can you send more details?")) === null);
t("long reply mentioning unsubscribe NOT skipped", classifyNoise(mkReply("Normally I unsubscribe from these but this caught my eye. " + "We run a plumbing business and this could help. ".repeat(6))) === null);

// --- quote stripping ---
const quoted = "let's do it\n\nOn Mon, Aug 24, 2026 at 9:01 AM Alex wrote:\n> I install an AI cold email system\n> Also including mine - https://calendly.com/your-name/30min";
t("stripQuoted removes thread history", stripQuoted(quoted) === "let's do it");
t("own calendly link in QUOTED thread does not trigger do-not-reply", detectSchedulingLink(stripQuoted(quoted), "https://calendly.com/your-name/30min") === null);
t("prospect's calendly link triggers do-not-reply", detectSchedulingLink("here's my link https://calendly.com/sam-oversoul/intro", "https://calendly.com/your-name/30min") !== null);
t("prospect's non-calendly scheduler triggers too", detectSchedulingLink("book me: https://savvycal.com/sam/30", null) !== null);
t("no link, no trigger", detectSchedulingLink("sounds good, what times work?", null) === null);

// --- the real offer sheet (mirrors schema.sql seed) ---
const sheet: OfferSheet = {
  key: "ai-cold-email-system", is_global: false, offer_name: "AI Cold Email System",
  original_pitch: "Hey {{firstName}}, ... I install an AI cold email system that books qualified sales calls ~ done-for-you. No Risk ~ No setup fee. No long term contracts. Do you have 10mins to chat about it tmw? Alex",
  sender_name: "Alex", sender_role: "Founder, Your Company", sender_signoff: "Alex",
  offer_facts: "Done-for-you AI cold email lead gen system that books qualified sales calls. No setup fee. No long-term contracts.",
  high_level_answer: "We build an AI-powered cold email system that identifies your ideal prospects and sends personalized outreach at scale to generate interested replies and sales opportunities.",
  pricing_policy: "quote_range", pricing_facts: "$X-Yk/month (FILL ME IN)",
  lead_magnet: "100 ICP-matched leads & 3 copy angles", price_reply: null,
  calendly_url: "https://calendly.com/your-name/30min",
  common_questions: [], ideal_replies: [],
  voice_rules: "short", max_words: 150,
  banned_phrases: ["just checking in", "synergy"], business_noun: "business", timezone: "America/New_York",
};
const lead = { email: "a@b.com", first_name: "Sean", company_name: "Acme Plumbing", website: "acmeplumbing.com" };
const slots = { ok: true, slots: ["Tuesday at 3:00 PM EDT", "Wednesday at 4:30 PM EDT"] };
const noSlots = { ok: false, slots: [] };

// --- template assembly ---
const interested = assembleReply({ bucket: "positive_interested", sheet, lead, slots })!;
t("interested: greets + 'sounds great'", interested.startsWith("Hi Sean sounds great."));
t("interested: proposes both slots", interested.includes("Tuesday at 3:00 PM EDT") && interested.includes("Wednesday at 4:30 PM EDT"));
t("interested: google meet line", interested.includes("calendar invite for a Google Meet"));
t("interested: calendly link", interested.includes(sheet.calendly_url!));
t("interested: ends with sign-off", interested.trimEnd().endsWith("Alex"));

const price = assembleReply({ bucket: "positive_price", sheet, lead, slots: noSlots })!;
t("price: quotes range verbatim", price.includes("as little as $X-Yk/month (FILL ME IN) before"));
t("price: includes lead magnet", price.includes("100 ICP-matched leads & 3 copy angles (no strings attached)"));
t("price: next-hour push", price.includes("15-min call in the next hour"));
t("price bucket needs no slots", !bucketNeedsSlots("positive_price"));

const noPriceSheet = { ...sheet, pricing_policy: "no_price_before_call" as const };
t("price template refuses when policy forbids quoting", assembleReply({ bucket: "positive_price", sheet: noPriceSheet, lead, slots: noSlots }) === null);

// --- price_reply override: an offer whose answer to "what does it cost"
//     is not a number. Mirrors the speed-to-lead sheet in schema.sql.
const freeSheet: OfferSheet = {
  ...sheet, key: "speed-to-lead", offer_name: "Speed to Lead",
  pricing_policy: "no_price_before_call", pricing_facts: null, lead_magnet: null,
  price_reply: "Great question - it's completely free. I build and install the whole system for you, you use it on your own leads, and then you decide if you want to keep it.\n\nAre you open to a 15-min call in the next hour? I can show you exactly how it would work for you.",
  high_level_answer: "We install a system that answers every new inbound lead in under 60 seconds.",
};
const freePrice = assembleReply({ bucket: "positive_price", sheet: freeSheet, lead, slots: noSlots })!;
// The ordering guard: without the override branch running FIRST,
// no_price_before_call returns null and every price question is held.
t("price override: overrides the no_price_before_call refusal", freePrice !== null);
t("price override: body used verbatim", freePrice.includes(freeSheet.price_reply!));
t("price override: still greets by name", freePrice.startsWith("Hi Sean,"));
t("price override: still ends with sign-off", freePrice.trimEnd().endsWith("Alex"));
t("price override: states no dollar figure", !/[$£€]\s?\d/.test(freePrice));

// Two-offer isolation: neither sheet may produce the other's wording.
t("price override: no leak of the other offer's range", !freePrice.includes("$X-Yk/month (FILL ME IN)"));
t("price override: no leak of the other offer's magnet", !freePrice.includes("ICP-matched leads"));
t("price template unchanged when price_reply is null", price.includes("as little as $X-Yk/month (FILL ME IN) before") && !price.includes("completely free"));
t("soft_info stays per-offer", assembleReply({ bucket: "positive_soft_info", sheet: freeSheet, lead, slots })!.includes(freeSheet.high_level_answer!));

const softInfo = assembleReply({ bucket: "positive_soft_info", sheet, lead, slots })!;
t("soft_info: high level answer", softInfo.includes(sheet.high_level_answer!));
t("soft_info: otherwise-times fallback", softInfo.includes("Otherwise are you available Tuesday at 3:00 PM EDT"));
t("soft_info refuses without high_level_answer", assembleReply({ bucket: "positive_soft_info", sheet: { ...sheet, high_level_answer: null }, lead, slots }) === null);

const later = assembleReply({ bucket: "positive_soft_later", sheet, lead, slots, timeframe: "Q3" })!;
t("soft_later: echoes timeframe", later.includes("follow up in Q3"));
t("soft_later: still asks for the intro", later.includes("15-minute introduction next week"));

const referral = assembleReply({ bucket: "positive_referral", sheet, lead, slots: noSlots })!;
t("referral: asks for email intro", referral.includes("introducing us by email"));

const owntime = assembleReply({ bucket: "positive_owntime", sheet, lead, slots: noSlots, timeframe: "3pm on Monday" })!;
t("owntime: accepts their time verbatim", owntime.includes("Yes, 3pm on Monday works."));
t("owntime: promises the invite", owntime.includes("I'll send you a google meet invite."));
t("owntime: greets by name", owntime.startsWith("Hi Sean"));
t("owntime: ends with sign-off", owntime.trimEnd().endsWith("Alex"));
t("owntime: no slots proposed", !owntime.includes("Are you available"));
t("owntime bucket needs no slots", !bucketNeedsSlots("positive_owntime"));
t("owntime refuses without a time", assembleReply({ bucket: "positive_owntime", sheet, lead, slots: noSlots }) === null);

t("non-positive buckets produce nothing", assembleReply({ bucket: "negative_notfit", sheet, lead, slots: noSlots }) === null);

const degraded = assembleReply({ bucket: "positive_interested", sheet, lead, slots: noSlots })!;
t("calendar failure degrades to asking availability", degraded.includes("What does your calendar look like"));

const noName = assembleReply({ bucket: "positive_interested", sheet, lead: { email: "a@b.com" }, slots })!;
t("no first name degrades to bare 'Hi'", noName.startsWith("Hi sounds great."));

// --- deterministic checks pass every real template ---
for (const [name, body] of [["interested", interested], ["price", price], ["soft_info", softInfo], ["soft_later", later], ["referral", referral], ["owntime", owntime], ["degraded", degraded]] as const) {
  const r = runChecks({ finalBody: body, sheet, globalFacts: "", lead });
  t(`checks pass template: ${name}${r.pass ? "" : " → " + r.failures.join("; ")}`, r.pass);
}

// The whole point of price_reply: a free-build price answer must survive
// the gate under no_price_before_call, where any dollar figure hard-fails.
for (const [name, body] of [
  ["price", freePrice],
  ["soft_info", assembleReply({ bucket: "positive_soft_info", sheet: freeSheet, lead, slots })!],
  ["interested", assembleReply({ bucket: "positive_interested", sheet: freeSheet, lead, slots })!],
] as const) {
  const r = runChecks({ finalBody: body, sheet: freeSheet, globalFacts: "", lead });
  t(`checks pass free-offer template: ${name}${r.pass ? "" : " → " + r.failures.join("; ")}`, r.pass);
}

// --- checks still catch corruption ---
const wrongPrice = price.replace("$X-Yk/month (FILL ME IN)", "$2,000/m");
t("wrong price fails", !runChecks({ finalBody: wrongPrice, sheet, globalFacts: "", lead }).pass);

const leakedPrice = interested.replace("sounds great.", "sounds great. It costs $2,500.");
t("price not in sheet fails", !runChecks({ finalBody: leakedPrice, sheet, globalFacts: "", lead }).pass);

const wrongNoun = interested.replace("sounds great.", "sounds great. Perfect for your clinic.");
const rn = runChecks({ finalBody: wrongNoun, sheet, globalFacts: "", lead });
t("wrong business noun fails", !rn.pass && rn.failures.some((f) => f.includes("clinic")));

const shopLead = { email: "a@b.com", first_name: "Sean", company_name: "The Print Shop", website: "printshop.com" };
const shopBody = interested.replace("sounds great.", "sounds great. Perfect for your shop.");
t("noun allowed when in company name", runChecks({ finalBody: shopBody, sheet, globalFacts: "", lead: shopLead }).pass);
t("noun NOT allowed otherwise", !runChecks({ finalBody: shopBody, sheet, globalFacts: "", lead }).pass);

const emdash = interested.replace("sounds great.", "sounds great — truly.");
t("em-dash fails", !runChecks({ finalBody: emdash, sheet, globalFacts: "", lead }).pass);

const banned = interested.replace("sounds great.", "sounds great, just checking in.");
t("banned phrase fails", !runChecks({ finalBody: banned, sheet, globalFacts: "", lead }).pass);

const foreignUrl = interested.replace("sounds great.", "sounds great. See https://yourcompany.example too.");
t("non-calendly URL fails", !runChecks({ finalBody: foreignUrl, sheet, globalFacts: "", lead }).pass);

const placeholder = interested.replace("Sean", "{{first_name}}");
t("placeholder fails", !runChecks({ finalBody: placeholder, sheet, globalFacts: "", lead }).pass);

const noGreet = interested.replace("Hi Sean", "Hi there");
t("missing first-name greeting fails", !runChecks({ finalBody: noGreet, sheet, globalFacts: "", lead }).pass);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
Deno.exit(failures === 0 ? 0 : 1);
