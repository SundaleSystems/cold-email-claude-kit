// The hunt, top to bottom. Runs in the background after the webhook has
// already answered {ok:true}.
//
//   event filter → one-shot dedup → fetch lead + reply → parse signature
//   → parse location → FPS ‖ TPS ‖ LeadMagic → score → alert → log
//
// Every external step is individually non-fatal: the alert is assembled
// from whatever survived, with a per-source status footer so a dead
// source is visible in the very alert it degraded. The log row is the
// backstop if even the alert fails.
import { runSkipTrace } from "./apify.ts";
import { config } from "./config.ts";
import { insertLogRow, updateLogRow } from "./db.ts";
import { sendAlertEmail } from "./gmail.ts";
import { getLatestReply, getLead } from "./instantly.ts";
import { findMobile } from "./leadmagic.ts";
import { parseLocation } from "./location.ts";
import { emailHtml, emailSubject, slackMessage, slackPost } from "./notify.ts";
import { candidatesFromSignature, scoreAndSort } from "./score.ts";
import { parseSignature } from "./signature.ts";
import type { LeadKeys, PhoneCandidate, SourceStatus } from "./types.ts";

const POSITIVE = /(interested|meeting[_ ]?booked|positive)/;
const NEGATIVE = /not[_ ]?interested/;

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

export async function runPhoneHunt(payload: any): Promise<void> {
  const started = Date.now();

  // Instantly's webhook may nest the real body under .body.
  const wh = payload?.body ?? payload ?? {};
  const eventType = str(wh.event_type).toLowerCase();

  // 1. Event filter — only positive events, and never a "not interested".
  if (!POSITIVE.test(eventType) || NEGATIVE.test(eventType)) {
    console.log(`skip: non-positive event "${eventType}"`);
    return;
  }

  const email = str(wh.lead_email ?? wh.email).trim().toLowerCase();
  const campaignId = str(wh.campaign_id ?? wh.campaignId);
  if (!email || !campaignId) {
    console.error("skip: missing lead_email or campaign_id on payload");
    return;
  }

  // 2. One-shot dedup. Insert first; a duplicate returns null and stops.
  let logId: string | null;
  try {
    logId = await insertLogRow({
      campaign_id: campaignId,
      lead_email: email,
      event_type: eventType,
      first_name: str(wh.firstName) || null,
      last_name: str(wh.lastName) || null,
      company_name: str(wh.companyName) || null,
      campaign_name: str(wh.campaign_name) || null,
      status: "processing",
    });
  } catch (err) {
    console.error("insertLogRow failed — aborting:", err);
    return;
  }
  if (!logId) {
    console.log(`skip: already hunted ${email} in ${campaignId}`);
    return;
  }

  const status: SourceStatus = {};

  try {
    // 3. Enrich from Instantly (both non-fatal, in parallel).
    const [replyRes, leadRes] = await Promise.allSettled([
      getLatestReply(email, campaignId),
      getLead(email, campaignId),
    ]);
    const reply = replyRes.status === "fulfilled" ? replyRes.value : null;
    const lead = leadRes.status === "fulfilled" ? leadRes.value : null;
    const cv = (lead?.custom_variables ?? {}) as Record<string, unknown>;

    // Prefer an explicit "City, ST" location string; fall back to separate
    // city/state fields Instantly sometimes stores.
    const locationRaw = str(cv.location) ||
      [str(cv.city), str(cv.state)].filter(Boolean).join(", ");
    let { city, state } = parseLocation(locationRaw);
    if (!state && str(cv.state)) state = str(cv.state).toUpperCase().slice(0, 2);
    if (!city && str(cv.city)) city = str(cv.city);

    const k: LeadKeys = {
      eventType,
      campaignId,
      campaignName: str(wh.campaign_name),
      firstName: str(wh.firstName || lead?.first_name || cv.first_name),
      lastName: str(wh.lastName || lead?.last_name || cv.last_name),
      email,
      companyName: str(wh.companyName || lead?.company_name || cv.company_name),
      industry: str(cv.company_industry),
      locationRaw,
      city,
      state,
      linkedinUrl: str(cv.linkedin_url),
      companyPhone: str(cv.company_phone || wh.phone),
      replyText: reply?.text ?? "",
    };

    // 4. Signature — free, always runs.
    const sigNumbers = parseSignature(reply?.text ?? "", reply?.html ?? "", k.companyPhone);
    status.signature = reply ? `ok:${sigNumbers.length}` : "no-reply";

    // 5 & 6. Skip-trace people-search (self-skips without a location) +
    // LeadMagic, in parallel.
    const jobs: Promise<{ source: string; candidates: PhoneCandidate[]; status: string }>[] = [
      runSkipTrace(k).then((r) => ({ source: "skiptrace", ...r })),
      findMobile(k).then((r) => ({ source: "leadmagic", ...r })),
    ];

    const settled = await Promise.allSettled(jobs);
    const candidates: PhoneCandidate[] = [...candidatesFromSignature(sigNumbers)];
    for (const s of settled) {
      if (s.status === "fulfilled") {
        candidates.push(...s.value.candidates);
        status[s.value.source] = s.value.status;
      }
    }

    // 7. Score + dedupe.
    const result = scoreAndSort(candidates);

    // 8. Alert — Slack always, email if enabled. Neither can throw.
    const slackStatus = await slackPost(slackMessage(k, result, status));
    status.slack = slackStatus;
    if (config.gmailEnabled) {
      status.gmail = await sendAlertEmail(emailSubject(k), emailHtml(k, result, status));
    }

    // 9. Persist results.
    await updateLogRow(logId, {
      first_name: k.firstName || null,
      last_name: k.lastName || null,
      company_name: k.companyName || null,
      campaign_name: k.campaignName || null,
      location_raw: k.locationRaw || null,
      city: k.city,
      state: k.state,
      linkedin_url: k.linkedinUrl || null,
      reply_excerpt: k.replyText ? k.replyText.slice(0, 500) : null,
      candidates: [...result.mobiles, ...result.others],
      source_status: status,
      mobiles_found: result.mobiles.length,
      others_found: result.others.length,
      duration_ms: Date.now() - started,
      status: "done",
    });
    console.log(`done: ${email} — ${result.mobiles.length} cell / ${result.others.length} other`);
  } catch (err) {
    console.error("hunt failed:", err);
    // Best-effort: alert you a positive reply came in even if the hunt broke.
    await slackPost(
      `:rotating_light: *SPEED TO CALL error* — positive reply from ${email} but the phone hunt failed. Check the thread.\n\`\`\`${
        String(err).slice(0, 800)
      }\`\`\``,
    );
    try {
      await updateLogRow(logId, {
        source_status: status,
        duration_ms: Date.now() - started,
        status: "error",
        error: String(err).slice(0, 1000),
      });
    } catch (_) { /* log write is the last thing we can do */ }
  }
}
