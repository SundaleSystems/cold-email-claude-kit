// The shared sandbox engine: one prospect reply in, one outcome out.
//
// Both the batch runner (run.ts) and the manual tester (serve.ts) call
// runReply(), so there is exactly one copy of the gate order in the
// sandbox. That order mirrors
// supabase/functions/reply-gate/pipeline.ts — if you add or reorder a gate
// there, change runReply() to match.
//
// Nothing here sends, logs or posts. db.ts, instantly.ts, slack.ts and
// sender.ts are never imported.
import {
  AUTO_REPLY_BUCKETS, HOLD_REASONS,
} from "../../supabase/functions/reply-gate/types.ts";
import type {
  Bucket, CalendarSlots, CheckResult, Classification, InboundReply, Lead,
  OfferSheet, VerifierResult,
} from "../../supabase/functions/reply-gate/types.ts";

const FN = "../../supabase/functions/reply-gate/";

export type Outcome = "send" | "held" | "skipped" | "error";

export interface ReplyOutcome {
  outcome: Outcome;
  /** Where it came to rest: noise, offer-sheet, scheduling-link, classifier, assembly, gate, passed, exception. */
  stage: string;
  bucket?: string;
  confidence?: number;
  reasoning?: string;
  draft?: string;
  reason?: string;
  checkFailures?: string[];
  verifier?: VerifierResult;
  retried?: boolean;
  slotsOk?: boolean;
  ms: number;
}

/** The reply-gate modules, imported dynamically after the env is populated. */
export interface GateModules {
  classifyNoise: (reply: InboundReply) => string | null;
  detectSchedulingLink: (ownText: string, ourCalendlyUrl?: string | null) => string | null;
  stripQuoted: (text: string) => string;
  classifyReply: (args: {
    sheet: OfferSheet; globalFacts: string; lead: Lead;
    replySubject: string; replyText: string; verifierFeedback?: string;
  }) => Promise<Classification>;
  assembleReply: (args: {
    bucket: Bucket; sheet: OfferSheet; lead: Lead; slots: CalendarSlots; timeframe?: string;
  }) => string | null;
  bucketNeedsSlots: (bucket: Bucket) => boolean;
  runChecks: (args: { finalBody: string; sheet: OfferSheet; globalFacts: string; lead: Lead }) => CheckResult;
  verifyDraft: (args: {
    finalBody: string; sheet: OfferSheet; globalFacts: string; lead: Lead;
    replySubject: string; replyText: string;
  }) => Promise<VerifierResult>;
  getTwoFreeSlots: (timezone: string) => Promise<CalendarSlots>;
}

export interface GateConfig {
  confidenceThreshold: number;
  draftModel: string;
  verifyModel: string;
}

/**
 * Import the real reply-gate modules. Must be called AFTER loadEnv():
 * config.ts throws at import time on a missing secret, which is why these
 * are dynamic imports rather than statics at the top of the file.
 */
export async function loadGate(): Promise<{ mods: GateModules; config: GateConfig }> {
  const noise = await import(FN + "noise.ts");
  const drafter = await import(FN + "drafter.ts");
  const checks = await import(FN + "checks.ts");
  const verifier = await import(FN + "verifier.ts");
  const calendly = await import(FN + "calendly.ts");
  const cfg = await import(FN + "config.ts");
  return {
    mods: {
      classifyNoise: noise.classifyNoise,
      detectSchedulingLink: noise.detectSchedulingLink,
      stripQuoted: noise.stripQuoted,
      classifyReply: drafter.classifyReply,
      assembleReply: drafter.assembleReply,
      bucketNeedsSlots: drafter.bucketNeedsSlots,
      runChecks: checks.runChecks,
      verifyDraft: verifier.verifyDraft,
      getTwoFreeSlots: calendly.getTwoFreeSlots,
    },
    config: cfg.config,
  };
}

export interface SheetBundle {
  pulledFrom: string;
  byKey: Map<string, OfferSheet>;
  globalFacts: string;
  defaultKey: string;
}

/**
 * Read the offer sheets pulled from Supabase by pull.ts. Mirrors db.ts
 * getGlobalFacts: an unfinished global row must not leak "FILL ME IN"
 * into a prompt, so it contributes nothing.
 */
export function loadSheets(path: string): SheetBundle {
  const file = JSON.parse(Deno.readTextFileSync(path)) as {
    pulled_from?: string; sheets: OfferSheet[];
  };
  const globalRow = file.sheets.find((s) => s.is_global);
  const facts = globalRow?.offer_facts ?? "";
  const firstOffer = file.sheets.find((s) => !s.is_global);
  return {
    pulledFrom: file.pulled_from ?? "local",
    byKey: new Map(file.sheets.map((s) => [s.key, s])),
    globalFacts: facts.includes("FILL ME IN") ? "" : facts,
    defaultKey: firstOffer?.key ?? "ai-cold-email-system",
  };
}

export type Stage =
  | "classifying" | "assembling" | "checking" | "verifying" | "retrying";

/**
 * Run one reply through every real gate, in the same order production
 * uses. onStage fires as it moves so a caller can show progress during
 * the two model calls.
 */
export async function runReply(args: {
  reply: InboundReply;
  lead: Lead;
  sheet: OfferSheet | undefined;
  offerKey: string;
  globalFacts: string;
  slots: CalendarSlots;
  mods: GateModules;
  config: GateConfig;
}, onStage?: (stage: Stage) => void): Promise<ReplyOutcome> {
  const { reply, lead, sheet, globalFacts, slots, mods, config } = args;
  const started = Date.now();
  const done = (r: Omit<ReplyOutcome, "ms">): ReplyOutcome => ({ ...r, ms: Date.now() - started });
  const stage = (s: Stage) => onStage?.(s);

  try {
    // Analyse only what the prospect actually typed — the quoted thread
    // below their reply is OUR email, including our own Calendly link.
    const ownText = mods.stripQuoted(reply.text) || reply.text;

    // 02 — noise filter, before any AI
    const noise = mods.classifyNoise(reply);
    if (noise) {
      return done({ outcome: "skipped", stage: "noise", reason: `Noise filter: ${noise}. No AI was called and no reply would be drafted.` });
    }

    // 03 — offer sheet. No sheet means no reply, by design.
    if (!sheet) {
      return done({ outcome: "held", stage: "offer-sheet", reason: `No offer sheet "${args.offerKey}" in data/offer-sheets.json. Run: deno run -A sandbox/pull.ts` });
    }
    if ((sheet.original_pitch ?? "").includes("FILL ME IN") || (sheet.offer_facts ?? "").includes("FILL ME IN")) {
      return done({ outcome: "held", stage: "offer-sheet", reason: `Offer sheet "${sheet.key}" still contains FILL ME IN. The pipeline refuses to draft from an unfinished sheet.` });
    }

    // 02b — they sent THEIR scheduling link. Book in their calendar and
    // reply by hand; no auto-reply, by design.
    const schedLink = mods.detectSchedulingLink(ownText, sheet.calendly_url);
    if (schedLink) {
      return done({ outcome: "held", stage: "scheduling-link", reason: `They sent their calendar link (${schedLink}). Book the meeting in THEIR calendar and reply manually. No auto-reply, by design.` });
    }

    // 05 — classify into a bucket. Templates do the writing.
    stage("classifying");
    let cls = await mods.classifyReply({ sheet, globalFacts, lead, replySubject: reply.subject, replyText: ownText });

    if (!AUTO_REPLY_BUCKETS.has(cls.bucket)) {
      return done({
        outcome: "held", stage: "classifier", bucket: cls.bucket,
        confidence: cls.confidence, reasoning: cls.reasoning,
        reason: HOLD_REASONS[cls.bucket as Bucket] ?? `Bucket "${cls.bucket}" has no template.`,
      });
    }
    if (cls.confidence < config.confidenceThreshold) {
      // Production stops here and never builds the reply. In the sandbox
      // we assemble the template anyway, so you can see what it WOULD
      // have said had the classifier been confident enough.
      const wouldSlots: CalendarSlots = mods.bucketNeedsSlots(cls.bucket) ? slots : { ok: false, slots: [] };
      const wouldBe = mods.assembleReply({ bucket: cls.bucket, sheet, lead, slots: wouldSlots, timeframe: cls.timeframe });
      return done({
        outcome: "held", stage: "classifier", bucket: cls.bucket,
        confidence: cls.confidence, reasoning: cls.reasoning,
        draft: wouldBe ?? undefined,
        reason: `Confidence ${cls.confidence.toFixed(2)} is under the ${config.confidenceThreshold} threshold${wouldBe ? " — the draft above is what it would have sent if it were confident" : ""}.`,
      });
    }

    // 04 + assembly — real slots only for the buckets whose template uses them
    stage("assembling");
    const useSlots: CalendarSlots = mods.bucketNeedsSlots(cls.bucket) ? slots : { ok: false, slots: [] };
    let finalBody = mods.assembleReply({ bucket: cls.bucket, sheet, lead, slots: useSlots, timeframe: cls.timeframe });
    if (!finalBody) {
      return done({
        outcome: "held", stage: "assembly", bucket: cls.bucket,
        confidence: cls.confidence, reasoning: cls.reasoning,
        reason: `Bucket "${cls.bucket}" could not be assembled: either an offer sheet field it needs is empty (pricing_facts or price_reply / high_level_answer / the pricing policy forbids quoting and no price_reply is set), or no proposed time was extracted for positive_owntime.`,
      });
    }

    // 06 — the gate: code first, then the independent verifier
    stage("checking");
    let checks = mods.runChecks({ finalBody, sheet, globalFacts, lead });
    if (checks.pass) stage("verifying");
    let verdict = checks.pass
      ? await mods.verifyDraft({ finalBody, sheet, globalFacts, lead, replySubject: reply.subject, replyText: ownText })
      : null;
    let retried = false;

    // One retry, fed by whichever layer failed. The templates are
    // deterministic, so landing on the same bucket cannot change the
    // outcome — hold instead of looping.
    if (!checks.pass || (verdict && !verdict.overall_pass)) {
      retried = true;
      stage("retrying");
      const feedback = !checks.pass
        ? `Deterministic checks failed: ${checks.failures.join("; ")}`
        : verdict!.feedback || "Reviewer failed the draft.";
      const retry = await mods.classifyReply({ sheet, globalFacts, lead, replySubject: reply.subject, replyText: ownText, verifierFeedback: feedback });

      if (retry.bucket === cls.bucket || !AUTO_REPLY_BUCKETS.has(retry.bucket) || retry.confidence < config.confidenceThreshold) {
        return done({
          outcome: "held", stage: "gate", retried,
          bucket: retry.bucket, confidence: retry.confidence, reasoning: retry.reasoning,
          draft: finalBody, checkFailures: checks.pass ? undefined : checks.failures,
          verifier: verdict ?? undefined,
          reason: `Gate failed and the retry did not produce a confident different bucket (first: ${cls.bucket}, retry: ${retry.bucket} @ ${retry.confidence.toFixed(2)}). Gate feedback: ${feedback}`,
        });
      }

      cls = retry;
      const retrySlots: CalendarSlots = mods.bucketNeedsSlots(cls.bucket) ? slots : { ok: false, slots: [] };
      finalBody = mods.assembleReply({ bucket: cls.bucket, sheet, lead, slots: retrySlots, timeframe: cls.timeframe });
      if (!finalBody) {
        return done({ outcome: "held", stage: "gate", retried, bucket: cls.bucket, confidence: cls.confidence, reasoning: cls.reasoning, reason: `Retry bucket "${cls.bucket}" needs offer sheet fields that are empty.` });
      }
      checks = mods.runChecks({ finalBody, sheet, globalFacts, lead });
      if (!checks.pass) {
        return done({ outcome: "held", stage: "gate", retried, bucket: cls.bucket, confidence: cls.confidence, reasoning: cls.reasoning, draft: finalBody, checkFailures: checks.failures, reason: "Failed deterministic checks after the retry." });
      }
      stage("verifying");
      verdict = await mods.verifyDraft({ finalBody, sheet, globalFacts, lead, replySubject: reply.subject, replyText: ownText });
      if (!verdict.overall_pass) {
        return done({ outcome: "held", stage: "gate", retried, bucket: cls.bucket, confidence: cls.confidence, reasoning: cls.reasoning, draft: finalBody, verifier: verdict, reason: `The verifier failed it twice. Last feedback: ${verdict.feedback}` });
      }
    }

    return done({
      outcome: "send", stage: "passed", retried,
      bucket: cls.bucket, confidence: cls.confidence, reasoning: cls.reasoning,
      draft: finalBody, verifier: verdict ?? undefined,
      slotsOk: mods.bucketNeedsSlots(cls.bucket) ? slots.ok : undefined,
    });
  } catch (e) {
    return done({ outcome: "error", stage: "exception", reason: String(e) });
  }
}
