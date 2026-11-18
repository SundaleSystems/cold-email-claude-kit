// Drafting = classification + template assembly.
//
// The model's only creative job is picking the bucket (and, for
// "reach out later" replies, echoing the prospect's timeframe). The
// reply bodies are your own fill-in-the-blank templates, assembled by
// code from the offer sheet — so the voice is guaranteed, the facts
// come from the sheet, and the model cannot improvise a sentence.
import { callClaudeJson } from "./claude.ts";
import { config } from "./config.ts";
import type { Bucket, CalendarSlots, Classification, Lead, OfferSheet } from "./types.ts";

export function buildOfferContext(sheet: OfferSheet, globalFacts: string): string {
  const qa = (sheet.common_questions ?? []).map((x) => `Q: ${x.q}\nA: ${x.a}`).join("\n\n");
  const ideals = (sheet.ideal_replies ?? []).map((r, i) => `--- Ideal reply example ${i + 1} ---\n${r}`).join("\n\n");
  return [
    `OFFER: ${sheet.offer_name ?? sheet.key}`,
    `THE ORIGINAL PITCH (the exact cold email this person received):\n${sheet.original_pitch ?? "(missing)"}`,
    `WHO IS WRITING: ${sheet.sender_name ?? ""}, ${sheet.sender_role ?? ""}.`,
    `OFFER FACTS:\n${sheet.offer_facts ?? "(missing)"}`,
    sheet.high_level_answer ? `HIGH-LEVEL ANSWER USED FOR INFO REQUESTS:\n${sheet.high_level_answer}` : "",
    globalFacts ? `COMPANY-WIDE FACTS:\n${globalFacts}` : "",
    `PRICING: policy ${sheet.pricing_policy}${sheet.pricing_facts ? `, quotable as "${sheet.pricing_facts}"` : ""}`,
    // Grounds the price template for offers whose answer to "what does it
    // cost" is not a number. Without this the verifier sees a claim the
    // offer facts never made and fails facts_grounded on every price reply.
    sheet.price_reply
      ? `STANDING PRICE ANSWER FOR THIS OFFER (sent verbatim, and sanctioned — not invented by the drafter):\n${sheet.price_reply}`
      : "",
    // Grounds the owntime template's "works" claim: accepting the
    // prospect's proposed time is standing policy, not an invented fact.
    `SCHEDULING POLICY: when a prospect proposes a specific time, ${sheet.sender_name ?? "the sender"} accepts that time and sends a Google Meet invite. This is standing policy; availability does not need checking. When a draft proposes specific dates and times itself, those are pulled live from ${sheet.sender_name ?? "the sender"}'s real calendar by code — treat them as grounded facts, not inventions.`,
    qa ? `COMMON QUESTIONS:\n${qa}` : "",
    ideals,
    `VOICE RULES:\n${sheet.voice_rules ?? ""}`,
  ].filter(Boolean).join("\n\n");
}

export async function classifyReply(args: {
  sheet: OfferSheet;
  globalFacts: string;
  lead: Lead;
  replySubject: string;
  replyText: string; // quote-stripped
  verifierFeedback?: string;
}): Promise<Classification> {
  const system = [
    `You classify a prospect's reply to a cold email into exactly one bucket. You do NOT write the reply — a fixed template is used for each bucket. Your classification decides which template (if any) is sent, so precision matters more than generosity.`,
    buildOfferContext(args.sheet, args.globalFacts),
    `BUCKETS:`,
    `- positive_interested: a yes — agreed to talk, "sounds great", "let's do it", "tell me more" with clear willingness to meet, but WITHOUT proposing a specific time of their own. The template proposes two call times.`,
    `- positive_owntime: proposes their own specific meeting time — "how is 3pm on Monday?", "can you do Thursday at 2?", "free tomorrow at noon?". The template accepts their time and promises a Google Meet invite. Set "timeframe" to their proposed time exactly in their words, e.g. "3pm on Monday". A vague "sometime next week" with no actual time is NOT this bucket.`,
    // What the price template actually DOES varies per offer. Telling the
    // classifier "it quotes the range" when the offer answers "it's free"
    // describes the wrong template and skews both bucket and confidence.
    args.sheet.price_reply
      ? `- positive_price: asks what it costs. The template gives this offer's standing answer on cost and pushes to a call.`
      : `- positive_price: asks what it costs. The template quotes the range and pushes to a call.`,
    `- positive_soft_info: asks for more info / details / a deck, without committing to a call. The template gives the high-level answer and pushes to a call.`,
    `- positive_soft_later: positive but defers — "reach out in Q3", "circle back next quarter". The template agrees to follow up AND asks for a 15-minute intro anyway. Set "timeframe" to their words, e.g. "Q3".`,
    `- positive_referral: clean handoff — "not me, talk to X". The template asks for an email intro. If it is anything more tangled than a clean handoff (their own other business, conditions attached), use "other" instead.`,
    `- neutral_question: a clarifying question with no commitment.`,
    `- negative_notnow / negative_notfit / negative_hostile: negatives; hostile = angry, threatening, or a spam complaint.`,
    `- unsubscribe / ooo / bounce: should be rare here (filtered earlier).`,
    `- other: ANYTHING you cannot place cleanly — multiple asks at once, mixed signals, a different business than the one pitched. When in doubt, "other". A held reply costs two minutes; a wrong template costs the lead.`,
    `OUTPUT: one JSON object, fields IN THIS ORDER:`,
    `{"reasoning": "2-4 sentences: what they are actually saying, and why this bucket",`,
    ` "bucket": "<one of the bucket names>",`,
    ` "confidence": 0.0-1.0 — your honest confidence that sending this bucket's template as-is is the right move,`,
    ` "timeframe": "for positive_soft_later: their timeframe in their words. For positive_owntime: their proposed time in their words. Else omit"}`,
  ].join("\n\n");

  const user = [
    `LEAD:`,
    `Email: ${args.lead.email}`,
    args.lead.first_name ? `First name: ${args.lead.first_name}` : "",
    args.lead.company_name ? `Company: ${args.lead.company_name}` : "",
    args.lead.website ? `Website: ${args.lead.website}` : "",
    ``,
    `THEIR REPLY (subject: ${args.replySubject}):`,
    args.replyText,
    args.verifierFeedback
      ? `\nA previous classification was rejected by an independent reviewer with this feedback. Reconsider:\n${args.verifierFeedback}`
      : "",
  ].filter((l) => l !== "").join("\n");

  const parsed = await callClaudeJson<Classification>({
    model: config.draftModel, system, user, maxTokens: 600, label: "classifier",
  });
  return {
    reasoning: parsed.reasoning ?? "",
    bucket: (parsed.bucket ?? "other") as Bucket,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    timeframe: parsed.timeframe,
  };
}

/** Which buckets need real Calendly slots in their template. */
export function bucketNeedsSlots(bucket: Bucket): boolean {
  return bucket === "positive_interested" || bucket === "positive_soft_info" || bucket === "positive_soft_later";
}

/**
 * Assemble the reply from the templates. Pure code: greeting, blanks
 * from the offer sheet, real slots, sign-off. The model contributes at
 * most the timeframe echo.
 */
export function assembleReply(args: {
  bucket: Bucket;
  sheet: OfferSheet;
  lead: Lead;
  slots: CalendarSlots;
  timeframe?: string;
}): string | null {
  const { bucket, sheet, lead, slots } = args;
  const first = lead.first_name?.trim().split(/\s+/)[0];
  const hi = first ? `Hi ${first}` : `Hi`;
  const signoff = (sheet.sender_signoff ?? "").trim();
  const calendly = sheet.calendly_url
    ? `If you have a calendar shoot it over and I'll find a time. Also including mine - ${sheet.calendly_url}`
    : `If you have a calendar shoot it over and I'll find a time.`;

  const timesQuestion = slots.ok && slots.slots.length >= 2
    ? `Are you available ${slots.slots[0]} or ${slots.slots[1]}?`
    : slots.ok && slots.slots.length === 1
    ? `Are you available ${slots.slots[0]}?`
    : null;
  const meetLine = `If so, let me know which and I'll send a calendar invite for a Google Meet.`;
  // Calendar lookup failed → degrade to the two remaining paths.
  const schedule = timesQuestion
    ? `${timesQuestion} ${meetLine}\n\n${calendly}`
    : `What does your calendar look like this week for a quick call?\n\n${calendly}`;

  switch (bucket) {
    case "positive_interested":
      return [`${hi} sounds great.`, schedule, signoff].join("\n\n");

    // They proposed a time → accept it, no matter what, in their words.
    // You send the actual Google Meet invite yourself.
    case "positive_owntime": {
      const time = args.timeframe?.trim();
      if (!time) return null; // classifier gave no time — held upstream
      return [
        hi,
        `Yes, ${time} works.`,
        `I'll send you a google meet invite.`,
        signoff,
      ].join("\n\n");
    }

    case "positive_price": {
      // An offer whose answer to "what does it cost" is not a number
      // (free build, pay only if you keep it) supplies the whole body.
      // This must come FIRST: such an offer runs no_price_before_call so
      // the gate hard-fails stray dollar figures, and the check below
      // would otherwise hold every price question on it.
      if (sheet.price_reply) return [`${hi},`, sheet.price_reply.trim(), signoff].join("\n\n");
      if (!sheet.pricing_facts || sheet.pricing_policy === "no_price_before_call") return null; // held upstream
      const magnet = sheet.lead_magnet ? ` I'll also include ${sheet.lead_magnet} (no strings attached).` : "";
      return [
        `${hi},`,
        `Great question - cost varies, and we've built this for as little as ${sheet.pricing_facts} before. Would depend on a few factors specific to your setup. Are you open to a 15-min call in the next hour? I can scope everything on the call and give you a price.${magnet}`,
        signoff,
      ].join("\n\n");
    }

    case "positive_soft_info": {
      if (!sheet.high_level_answer) return null; // held upstream
      const softSchedule = timesQuestion
        ? `Otherwise are you available ${slots.slots[0]} or ${slots.slots[1]}? ${meetLine}\n\n${calendly}`
        : calendly;
      return [
        `${hi},`,
        `Absolutely. ${sheet.high_level_answer} Are you open to a 15-min call in the next hour? ${softSchedule}`,
        signoff,
      ].join("\n\n");
    }

    case "positive_soft_later": {
      const tf = args.timeframe?.trim() || "then";
      return [
        `${hi},`,
        `Absolutely, I can follow up in ${tf}. Would you be opposed to a quick 15-minute introduction next week? That way, you can see how it works and determine if it even makes sense.`,
        schedule,
        signoff,
      ].join("\n\n");
    }

    case "positive_referral":
      return [`${hi},`, `Thanks, appreciate it. Would you mind introducing us by email? A quick intro would be great.`, signoff].join("\n\n");

    default:
      return null;
  }
}
