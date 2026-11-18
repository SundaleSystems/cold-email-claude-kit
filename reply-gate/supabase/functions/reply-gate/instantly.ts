// Instantly API v2 client. Bearer auth, retry on 429/5xx.
// Payload shapes per https://api.instantly.ai/openapi/api_v2.json
import { config } from "./config.ts";
import type { InboundReply, Lead } from "./types.ts";

const API = "https://api.instantly.ai";

async function instantlyFetch(path: string, init: RequestInit = {}, attempts = 4): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.instantlyApiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`instantly ${init.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
  }
}

/**
 * Pull the actual reply: latest received email from this lead in this
 * campaign. We never trust the webhook body for content — the API is
 * the source of truth.
 */
export async function getLatestReply(leadEmail: string, campaignId: string): Promise<InboundReply | null> {
  const qs = new URLSearchParams({
    lead: leadEmail,
    campaign_id: campaignId,
    email_type: "received",
    limit: "10",
  });
  const page = await instantlyFetch(`/api/v2/emails?${qs}`);
  const items: any[] = page.items ?? [];
  if (items.length === 0) return null;
  items.sort((a, b) =>
    new Date(b.timestamp_email ?? b.timestamp_created ?? 0).getTime() -
    new Date(a.timestamp_email ?? a.timestamp_created ?? 0).getTime()
  );
  const e = items[0];
  return {
    id: e.id,
    subject: e.subject ?? "",
    text: (e.body?.text ?? stripHtml(e.body?.html ?? "")).trim(),
    eaccount: e.eaccount ?? "",
    campaignId: e.campaign_id ?? campaignId,
    leadEmail,
    isAutoReply: e.is_auto_reply === 1 || e.is_auto_reply === true,
  };
}

/**
 * Pull the actual lead: first name, company, website, and the
 * personalised opening line the original cold email used. Non-fatal —
 * if this fails the reply degrades to a company-less version instead
 * of being lost.
 */
export async function getLead(leadEmail: string, campaignId: string): Promise<Lead> {
  try {
    const page = await instantlyFetch(`/api/v2/leads/list`, {
      method: "POST",
      body: JSON.stringify({ campaign: campaignId, search: leadEmail, limit: 5 }),
    });
    const item = (page.items ?? []).find((l: any) => (l.email ?? "").toLowerCase() === leadEmail.toLowerCase());
    if (!item) return { email: leadEmail };
    return {
      email: leadEmail,
      first_name: item.first_name ?? undefined,
      last_name: item.last_name ?? undefined,
      company_name: item.company_name ?? undefined,
      website: item.website ?? undefined,
      city: item.city ?? item.custom_variables?.city ?? undefined,
      personalization: item.personalization ?? item.custom_variables?.personalization ??
        item.custom_variables?.situation_line ?? undefined,
    };
  } catch (e) {
    console.error("lead lookup failed (non-fatal):", e);
    return { email: leadEmail };
  }
}

/** Send the reply from the same mailbox that ran the campaign. */
export async function sendReply(args: {
  replyToUuid: string;
  eaccount: string;
  subject: string;
  body: string;
}): Promise<any> {
  return instantlyFetch(`/api/v2/emails/reply`, {
    method: "POST",
    body: JSON.stringify({
      reply_to_uuid: args.replyToUuid,
      eaccount: args.eaccount,
      subject: args.subject.startsWith("Re:") ? args.subject : `Re: ${args.subject}`,
      body: {
        text: args.body,
        html: args.body.split("\n").map((l) => escapeHtml(l) || "<br>").join("<br>\n"),
      },
    }),
  });
}

export async function getCampaignName(campaignId: string): Promise<string> {
  try {
    const c = await instantlyFetch(`/api/v2/campaigns/${campaignId}`);
    return c.name ?? campaignId;
  } catch {
    return campaignId;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
