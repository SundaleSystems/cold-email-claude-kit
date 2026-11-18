// The alert: a Slack ping (day-one channel) and an optional HTML email.
// Both are built from the same scored numbers. The alert always fires —
// even with zero numbers found — because "a positive reply just came in
// and we couldn't get a number" is itself something you need to know.
import { config } from "./config.ts";
import { pretty } from "./score.ts";
import type { HuntResult, LeadKeys, ScoredPhone, SourceStatus } from "./types.ts";

export async function slackPost(text: string): Promise<string> {
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
    if (!data.ok) {
      console.error("slack error:", data.error);
      return `error:${data.error}`;
    }
    return "sent";
  } catch (e) {
    // Slack being down must never break the pipeline.
    console.error("slack post failed:", e);
    return "error";
  }
}

function fullName(k: LeadKeys): string {
  return `${k.firstName} ${k.lastName}`.replace(/\s+/g, " ").trim();
}

function statusFooter(status: SourceStatus): string {
  return Object.entries(status).map(([k, v]) => `${k} ${v}`).join(" · ");
}

/** Formatted number, with a dialing extension appended when present. */
function phoneText(c: ScoredPhone): string {
  return `${pretty(c.digits)}${c.ext ? ` ext. ${c.ext}` : ""}`;
}

// --- Slack (mrkdwn) ---

function slackLines(list: ScoredPhone[]): string {
  return list.map((c) => `  ${phoneText(c)} — ${c.score}% (${c.sourceList}: ${c.note})`).join("\n");
}

export function slackMessage(k: LeadKeys, result: HuntResult, status: SourceStatus): string {
  const { mobiles, others } = result;
  const who = fullName(k) || k.email;
  const header = `:telephone_receiver: *SPEED TO CALL — ${who} replied interested*`;
  const meta = [
    `Company: ${k.companyName || "Unknown"}${k.industry ? ` (${k.industry})` : ""}`,
    `Campaign: ${k.campaignName} · Lead: ${k.email}${k.locationRaw ? ` · ${k.locationRaw}` : ""}`,
  ];

  if (!mobiles.length && !others.length) {
    return [
      `:telephone_receiver: *SPEED TO CALL — positive reply from ${who}*`,
      `Company: ${k.companyName || "Unknown"} · Lead: ${k.email}`,
      "No phone numbers found across signature, FastPeopleSearch, TruePeopleSearch, or LeadMagic — check the thread.",
      `_Sources: ${statusFooter(status)}_`,
    ].join("\n");
  }

  const blocks = [header, meta.join("\n")];
  blocks.push(
    mobiles.length ? `*Cell numbers:*\n${slackLines(mobiles)}` : "_No cell numbers found._",
  );
  if (others.length) blocks.push(`*Other numbers:*\n${slackLines(others)}`);
  blocks.push(`_Sources: ${statusFooter(status)}_`);
  return blocks.join("\n\n");
}

// --- Email (HTML) ---

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlLines(list: ScoredPhone[]): string {
  return list.map((c) =>
    `${esc(phoneText(c))} &mdash; ${c.score}% <span style="color:#666">(${esc(c.sourceList)}: ${esc(c.note)})</span>`
  ).join("<br>");
}

export function emailSubject(k: LeadKeys): string {
  return `New Lead: ${fullName(k)} phone number`.replace(/\s+/g, " ").trim();
}

export function emailHtml(k: LeadKeys, result: HuntResult, status: SourceStatus): string {
  const { mobiles, others } = result;
  let numbersHtml: string;
  if (!mobiles.length && !others.length) {
    numbersHtml =
      "<em>No phone numbers found across signature, FastPeopleSearch, TruePeopleSearch, or LeadMagic.</em>";
  } else {
    numbersHtml = mobiles.length
      ? `<strong>Cell numbers found:</strong><br>${htmlLines(mobiles)}`
      : "<em>No cell numbers found.</em>";
    if (others.length) numbersHtml += `<br><br><strong>Other numbers found:</strong><br>${htmlLines(others)}`;
  }

  return [
    `<strong>${esc(k.companyName || "Unknown company")}</strong>`,
    esc(k.industry || "Industry unknown"),
    esc(fullName(k)),
    "",
    numbersHtml,
    "",
    `<span style="color:#999;font-size:12px">Campaign: ${esc(k.campaignName)} &middot; Lead: ${esc(k.email)}${
      k.locationRaw ? " &middot; " + esc(k.locationRaw) : ""
    }<br>Sources: ${esc(statusFooter(status))}</span>`,
  ].join("<br>");
}
