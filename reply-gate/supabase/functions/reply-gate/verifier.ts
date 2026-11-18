// The independent model goes second. A separate call with its own
// prompt: it sees the draft, the offer sheet, and the original pitch —
// never the drafter's reasoning.
//
// Two hard-won rules are baked in here:
// 1. Field order: evidence/analysis BEFORE any pass/fail. A model that
//    emits the verdict first commits to it and then argues with itself
//    in the evidence field — and the gate acts on the verdict it
//    already emitted.
// 2. Each criterion is ONE narrow question. "Appropriate for this
//    lead" means only "does the draft describe the lead accurately" —
//    it is not a licence to re-judge whether the prospect is a good
//    lead. That is a sales judgement, not a safety one, and the
//    prospect already replied with interest.
import { callClaudeJson } from "./claude.ts";
import { config } from "./config.ts";
import { buildOfferContext } from "./drafter.ts";
import type { Lead, OfferSheet, VerifierResult } from "./types.ts";

export async function verifyDraft(args: {
  finalBody: string;
  sheet: OfferSheet;
  globalFacts: string;
  lead: Lead;
  replySubject: string;
  replyText: string;
}): Promise<VerifierResult> {
  const system = [
    `You are an independent reviewer of an outbound email reply, drafted on behalf of ${args.sheet.sender_name ?? "the sender"}. You did not write it. Your only job is to decide whether it is safe to send.`,
    `Judge each criterion as ONE narrow question. Do not judge whether the prospect is a good sales fit — they already replied with interest, and that decision is not yours.`,
    `When you reason with examples, keep them abstract. Do not name specific industries.`,
    `THE OFFER CONTEXT THE DRAFT WAS ALLOWED TO USE:`,
    buildOfferContext(args.sheet, args.globalFacts),
    `OUTPUT: a single JSON object, nothing else. Fields IN THIS ORDER — all evidence before any verdict:`,
    `{"analysis": "3-6 sentences of overall reasoning, written BEFORE you decide anything",`,
    ` "criteria": {`,
    `   "facts_grounded":     {"evidence": "quote each factual claim in the draft and where the offer context supports it, or state which claim is unsupported", "pass": true|false},`,
    `   "intent_read":        {"evidence": "what the prospect actually asked or meant, and whether the draft responds to that", "pass": true|false},`,
    `   "pitch_consistent":   {"evidence": "does anything in the draft contradict the original pitch they received", "pass": true|false},`,
    `   "voice_and_format":   {"evidence": "tone, length, formatting versus the voice rules and ideal examples", "pass": true|false},`,
    `   "lead_described_accurately": {"evidence": "ONLY: does the draft describe this specific lead and their company accurately, with nothing invented", "pass": true|false}`,
    ` },`,
    ` "overall_pass": true|false — true only if every criterion passed,`,
    ` "feedback": "if failing: specific, actionable feedback for one redraft. If passing: empty string"}`,
  ].join("\n\n");

  const user = [
    `THE LEAD:`,
    `Email: ${args.lead.email}`,
    args.lead.first_name ? `First name: ${args.lead.first_name}` : "",
    args.lead.company_name ? `Company: ${args.lead.company_name}` : "",
    args.lead.website ? `Website: ${args.lead.website}` : "",
    ``,
    `WHAT THE PROSPECT WROTE (subject: ${args.replySubject}):`,
    args.replyText,
    ``,
    `THE DRAFT REPLY TO JUDGE (exactly as it would be sent):`,
    args.finalBody,
  ].filter((l) => l !== "").join("\n");

  // 2500, not 1500: five evidence fields plus analysis regularly overran
  // the old cap and the JSON arrived truncated.
  const parsed = await callClaudeJson<VerifierResult>({
    model: config.verifyModel, system, user, maxTokens: 2500, label: "verifier",
  });

  // Belt and braces: recompute overall from the criteria so a model
  // that contradicts itself cannot slip a fail through as a pass.
  const allPassed = Object.values(parsed.criteria ?? {}).every((c) => c?.pass === true);
  return {
    analysis: parsed.analysis ?? "",
    criteria: parsed.criteria ?? {},
    overall_pass: allPassed && parsed.overall_pass === true,
    feedback: parsed.feedback ?? "",
  };
}
