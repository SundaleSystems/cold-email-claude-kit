// Slack is the control panel: every held reply, every send, every skip.
import { config } from "./config.ts";

export async function slackPost(text: string): Promise<void> {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.slackBotToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: config.slackChannel, text, unfurl_links: false }),
    });
    const data = await res.json();
    if (!data.ok) console.error("slack error:", data.error);
  } catch (e) {
    // Slack being down must never break the pipeline.
    console.error("slack post failed:", e);
  }
}

function block(label: string, body: string): string {
  return `*${label}*\n${body.trim()}`;
}

export function heldMessage(args: {
  leadEmail: string;
  leadName?: string;
  company?: string;
  campaignName: string;
  replyText: string;
  draft?: string;
  reason: string;
}): string {
  const who = [args.leadName, args.company].filter(Boolean).join(", ");
  return [
    `:raised_hand: *HELD — reply needs a human* (${args.leadEmail}${who ? ` — ${who}` : ""})`,
    `Campaign: ${args.campaignName}`,
    block("Why it was held", args.reason),
    block("Their reply", truncate(args.replyText, 1500)),
    args.draft ? block("Draft (NOT sent — use it if it helps)", truncate(args.draft, 1500)) : "",
    "_Reply to them yourself from Instantly._",
  ].filter(Boolean).join("\n\n");
}

export function shadowMessage(args: {
  leadEmail: string;
  leadName?: string;
  company?: string;
  campaignName: string;
  replyText: string;
  finalBody: string;
  confidence: number;
  verdictSummary: string;
}): string {
  const who = [args.leadName, args.company].filter(Boolean).join(", ");
  return [
    `:ghost: *SHADOW — would have sent* (${args.leadEmail}${who ? ` — ${who}` : ""})`,
    `Campaign: ${args.campaignName} · confidence ${args.confidence.toFixed(2)} · ${args.verdictSummary}`,
    block("Their reply", truncate(args.replyText, 1200)),
    block("The draft it would have sent", truncate(args.finalBody, 1500)),
    "_Send it by hand if it is good. If it is wrong, fix the offer sheet, not the draft._",
  ].join("\n\n");
}

export function queuedMessage(args: {
  leadEmail: string;
  campaignName: string;
  finalBody: string;
  sendAt: string;
  delayMinutes: number;
}): string {
  return [
    `:hourglass_flowing_sand: *QUEUED — sending in ${args.delayMinutes} min* (${args.leadEmail})`,
    `Campaign: ${args.campaignName} · sends at ${args.sendAt}`,
    block("Body", truncate(args.finalBody, 1500)),
    "_To stop it: set the row's status to 'held' in replies_log, or flip SHADOW_MODE to true._",
  ].join("\n\n");
}

export function sentMessage(leadEmail: string, campaignName: string): string {
  return `:white_check_mark: *SENT* — reply to ${leadEmail} (${campaignName}) went out from the campaign mailbox.`;
}

export function skippedMessage(leadEmail: string, reason: string): string {
  return `:fast_forward: *SKIPPED* — ${leadEmail}: ${reason}`;
}

export function errorMessage(context: string, err: string): string {
  return `:rotating_light: *REPLY GATE ERROR* — ${context}\n\`\`\`${truncate(err, 800)}\`\`\``;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + " …[truncated]" : s;
}
