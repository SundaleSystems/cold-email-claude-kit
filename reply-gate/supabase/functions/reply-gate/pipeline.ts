// The pipeline: webhook payload in, one of four outcomes out —
// queued, shadow, held, or skipped. Every outcome is logged and
// reported to Slack. The default on any doubt is to escalate: a held
// reply costs two minutes, a wrong sent reply costs the lead.
import { config } from "./config.ts";
import {
  getCampaignMapping, getGlobalFacts, getOfferSheet,
  insertLogRow, updateLogRow,
} from "./db.ts";
import { getCampaignName, getLatestReply, getLead } from "./instantly.ts";
import { getTwoFreeSlots } from "./calendly.ts";
import { classifyNoise, detectSchedulingLink, stripQuoted } from "./noise.ts";
import { assembleReply, bucketNeedsSlots, classifyReply } from "./drafter.ts";
import { runChecks } from "./checks.ts";
import { verifyDraft } from "./verifier.ts";
import {
  errorMessage, heldMessage, queuedMessage, shadowMessage,
  skippedMessage, slackPost,
} from "./slack.ts";
import { AUTO_REPLY_BUCKETS, HOLD_REASONS } from "./types.ts";
import type { CalendarSlots } from "./types.ts";

export async function processInterestedLead(payload: any): Promise<void> {
  // Instantly webhook payloads vary slightly by event config; take the
  // identifiers defensively and treat the API as the source of truth
  // for everything else.
  const leadEmail: string | undefined =
    payload.lead_email ?? payload.lead?.email ?? payload.email;
  const campaignId: string | undefined =
    payload.campaign_id ?? payload.campaign?.id ?? payload.campaignId;

  if (!leadEmail || !campaignId) {
    await slackPost(errorMessage("webhook missing lead_email/campaign_id", JSON.stringify(payload).slice(0, 500)));
    return;
  }

  let logId: string | null = null;
  try {
    // One-shot guard: if we've already touched this lead in this
    // campaign, stay out of the conversation.
    logId = await insertLogRow({ lead_email: leadEmail, campaign_id: campaignId, status: "processing" });
    if (!logId) {
      console.log(`duplicate event for ${leadEmail} / ${campaignId} — already handled`);
      return;
    }

    const campaignName = await getCampaignName(campaignId);

    // 01 — pull the actual reply
    const reply = await getLatestReply(leadEmail, campaignId);
    if (!reply) {
      await updateLogRow(logId, { status: "held", decision: "held", decision_reason: "Lead marked interested but no received email found via API" });
      await slackPost(heldMessage({
        leadEmail, campaignName, replyText: "(no reply text found via API)",
        reason: "Marked Interested in Instantly, but the API returned no received email. Check the thread by hand.",
      }));
      return;
    }
    await updateLogRow(logId, {
      reply_subject: reply.subject, reply_text: reply.text,
      reply_to_uuid: reply.id, eaccount: reply.eaccount,
    });
    // Analyse only what the prospect actually typed — the quoted thread
    // below their reply is OUR email.
    const ownText = stripQuoted(reply.text) || reply.text;

    // 02 — skip the noise before any AI is involved
    const noise = classifyNoise(reply);
    if (noise) {
      await updateLogRow(logId, { status: "skipped", decision: "skipped", decision_reason: noise });
      await slackPost(skippedMessage(leadEmail, noise));
      return;
    }

    // 01b — pull the actual lead (non-fatal; degrades, never lost)
    const lead = await getLead(leadEmail, campaignId);
    await updateLogRow(logId, {
      lead_first_name: lead.first_name ?? null,
      lead_company: lead.company_name ?? null,
      lead_website: lead.website ?? null,
    });

    // 03 — load the right offer sheet. No match means no reply, by design.
    const mapping = await getCampaignMapping(campaignId);
    if (!mapping) {
      await updateLogRow(logId, { status: "held", decision: "held", decision_reason: "Campaign not in campaign_map" });
      await slackPost(heldMessage({
        leadEmail, leadName: lead.first_name, company: lead.company_name, campaignName,
        replyText: ownText,
        reason: `Campaign "${campaignName}" (${campaignId}) has no offer sheet mapped. Add a row to campaign_map to answer this campaign.`,
      }));
      return;
    }
    const sheet = await getOfferSheet(mapping.offer_key);
    const globalFacts = await getGlobalFacts();
    if (!sheet || (sheet.original_pitch ?? "").includes("FILL ME IN") || (sheet.offer_facts ?? "").includes("FILL ME IN")) {
      await updateLogRow(logId, { status: "held", decision: "held", offer_key: mapping.offer_key, decision_reason: "Offer sheet missing or still contains FILL ME IN placeholders" });
      await slackPost(heldMessage({
        leadEmail, leadName: lead.first_name, company: lead.company_name, campaignName,
        replyText: ownText,
        reason: `Offer sheet "${mapping.offer_key}" is missing or unfinished. Finish it in the knowledge_base table.`,
      }));
      return;
    }
    await updateLogRow(logId, { offer_key: mapping.offer_key });

    // 02b — prospect sent THEIR scheduling link → do not reply.
    // You book the meeting in their calendar and replies manually.
    const schedLink = detectSchedulingLink(ownText, sheet.calendly_url);
    if (schedLink) {
      await updateLogRow(logId, { status: "held", decision: "held", decision_reason: `Prospect sent their scheduling link: ${schedLink}` });
      await slackPost(heldMessage({
        leadEmail, leadName: lead.first_name, company: lead.company_name, campaignName,
        replyText: ownText,
        reason: `They sent their calendar link (${schedLink}). Book the meeting in THEIR calendar, then reply manually. No auto-reply, by design.`,
      }));
      return;
    }

    const hold = async (reason: string, cls?: { bucket: string; confidence: number; reasoning: string }, finalBody?: string) => {
      await updateLogRow(logId!, {
        status: "held", decision: "held", decision_reason: reason,
        intent: cls?.bucket ?? null, confidence: cls?.confidence ?? null,
        final_body: finalBody ?? null,
      });
      await slackPost(heldMessage({
        leadEmail, leadName: lead.first_name, company: lead.company_name, campaignName,
        replyText: ownText, draft: finalBody, reason,
      }));
    };

    // 05 — classify into the reply buckets. Templates do the writing.
    let cls = await classifyReply({
      sheet, globalFacts, lead, replySubject: reply.subject, replyText: ownText,
    });

    if (!AUTO_REPLY_BUCKETS.has(cls.bucket)) {
      const why = HOLD_REASONS[cls.bucket] ?? `Bucket "${cls.bucket}" has no template.`;
      await hold(`Classified "${cls.bucket}" (${cls.confidence.toFixed(2)}): ${why} Model reasoning: ${cls.reasoning}`, cls);
      return;
    }
    if (cls.confidence < config.confidenceThreshold) {
      await hold(`Classifier confidence ${cls.confidence.toFixed(2)} for "${cls.bucket}" is under the ${config.confidenceThreshold} threshold. Reasoning: ${cls.reasoning}`, cls);
      return;
    }

    // 04 — real free slots, only for buckets whose template needs them
    const slots: CalendarSlots = bucketNeedsSlots(cls.bucket)
      ? await getTwoFreeSlots(sheet.timezone ?? "America/New_York")
      : { ok: false, slots: [] };

    // Assemble from the template (pure code) and run the gate.
    let finalBody = assembleReply({ bucket: cls.bucket, sheet, lead, slots, timeframe: cls.timeframe });
    if (!finalBody) {
      await hold(`Bucket "${cls.bucket}" could not be assembled: either an offer sheet field it needs is empty (pricing_facts / high_level_answer / policy allows quoting), or no proposed time was extracted for positive_owntime.`, cls);
      return;
    }
    let checks = runChecks({ finalBody, sheet, globalFacts, lead });
    let verdict = checks.pass
      ? await verifyDraft({ finalBody, sheet, globalFacts, lead, replySubject: reply.subject, replyText: ownText })
      : null;

    // One retry: reclassification fed by whichever layer failed. The
    // templates are deterministic, so if the retry lands on the same
    // bucket the outcome cannot change — hold instead of looping.
    if (!checks.pass || (verdict && !verdict.overall_pass)) {
      const feedback = !checks.pass
        ? `Deterministic checks failed: ${checks.failures.join("; ")}`
        : verdict!.feedback || "Reviewer failed the draft.";
      const retry = await classifyReply({
        sheet, globalFacts, lead, replySubject: reply.subject, replyText: ownText,
        verifierFeedback: feedback,
      });
      if (
        retry.bucket === cls.bucket ||
        !AUTO_REPLY_BUCKETS.has(retry.bucket) ||
        retry.confidence < config.confidenceThreshold
      ) {
        await hold(`Gate failed and retry did not produce a confident different bucket (first: ${cls.bucket}, retry: ${retry.bucket} @ ${retry.confidence.toFixed(2)}). Gate feedback: ${feedback}`, retry, finalBody);
        return;
      }
      cls = retry;
      const retrySlots: CalendarSlots = bucketNeedsSlots(cls.bucket)
        ? await getTwoFreeSlots(sheet.timezone ?? "America/New_York")
        : { ok: false, slots: [] };
      finalBody = assembleReply({ bucket: cls.bucket, sheet, lead, slots: retrySlots, timeframe: cls.timeframe });
      if (!finalBody) {
        await hold(`Retry bucket "${cls.bucket}" needs offer sheet fields that are empty.`, cls);
        return;
      }
      checks = runChecks({ finalBody, sheet, globalFacts, lead });
      if (!checks.pass) {
        await hold(`Failed deterministic checks after retry: ${checks.failures.join("; ")}`, cls, finalBody);
        return;
      }
      verdict = await verifyDraft({ finalBody, sheet, globalFacts, lead, replySubject: reply.subject, replyText: ownText });
      if (!verdict.overall_pass) {
        await hold(`Verifier failed it twice. Last feedback: ${verdict.feedback}`, cls, finalBody);
        return;
      }
    }

    const verdictSummary = Object.entries(verdict!.criteria)
      .map(([k, v]) => `${v.pass ? "✓" : "✗"} ${k}`).join(" · ");
    await updateLogRow(logId, {
      intent: cls.bucket, confidence: cls.confidence,
      draft: finalBody, final_body: finalBody,
      checks: checks.detail, verifier: verdict,
    });

    // All gates passed. Shadow mode (global, or per-campaign live=false)
    // reports instead of sending.
    if (config.shadowMode || !mapping.live) {
      await updateLogRow(logId, {
        status: "shadow", decision: "shadow_approved",
        decision_reason: config.shadowMode ? "global shadow mode" : "campaign not live",
      });
      await slackPost(shadowMessage({
        leadEmail, leadName: lead.first_name, company: lead.company_name, campaignName,
        replyText: ownText, finalBody, confidence: cls.confidence, verdictSummary,
      }));
      if (bucketNeedsSlots(cls.bucket) && !slots.ok) {
        await slackPost(skippedMessage(leadEmail, `note: Calendly lookup failed (${slots.error}) — template degraded to asking their availability`));
      }
      return;
    }

    // Queue it, held four minutes so a human reply never looks robotic —
    // and so a Slack notification gives you a window to stop it.
    const sendAfter = new Date(Date.now() + config.sendDelayMinutes * 60_000);
    await updateLogRow(logId, {
      status: "queued", decision: "queued", decision_reason: "all gates passed",
      send_after: sendAfter.toISOString(),
    });
    await slackPost(queuedMessage({
      leadEmail, campaignName, finalBody,
      sendAt: sendAfter.toISOString(), delayMinutes: config.sendDelayMinutes,
    }));
  } catch (e) {
    console.error("pipeline error:", e);
    if (logId) await updateLogRow(logId, { status: "error", error: String(e) }).catch(() => {});
    await slackPost(errorMessage(`processing ${leadEmail} — reply to them by hand`, String(e)));
  }
}
