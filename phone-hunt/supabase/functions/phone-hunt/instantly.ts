// Instantly API v2 client. Bearer auth, retry on 429/5xx.
// The webhook payload carries only identifiers — the reply body and the
// lead's custom variables (location, linkedin_url, company_phone) come
// from here. Ported from reply-gate's instantly.ts.
import { config } from "./config.ts";
import { stripHtml } from "./signature.ts";
import type { InboundReply, InstantlyLead } from "./types.ts";

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
 * The lead's latest received email, for signature parsing. Non-fatal —
 * if it fails the signature source just yields nothing.
 */
export async function getLatestReply(leadEmail: string, campaignId: string): Promise<InboundReply | null> {
  try {
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
    const html = e.body?.html ?? "";
    return {
      id: e.id,
      subject: e.subject ?? "",
      text: (e.body?.text ?? stripHtml(html)).trim(),
      html,
    };
  } catch (err) {
    console.error("latest reply lookup failed (non-fatal):", err);
    return null;
  }
}

/**
 * The lead record. custom_variables carry location / linkedin_url /
 * company_phone / company_industry once the backfill lands. Non-fatal.
 */
export async function getLead(leadEmail: string, campaignId: string): Promise<InstantlyLead | null> {
  try {
    const page = await instantlyFetch(`/api/v2/leads/list`, {
      method: "POST",
      body: JSON.stringify({ campaign: campaignId, search: leadEmail, limit: 5 }),
    });
    const item = (page.items ?? []).find((l: any) =>
      (l.email ?? "").toLowerCase() === leadEmail.toLowerCase()
    );
    if (!item) return null;

    // Instantly keeps a lead's custom variables in `payload` (with camelCase
    // keys like `linkedIn`, `industry`, `city`), NOT `custom_variables`.
    // Merge both and normalize to the canonical keys the pipeline expects,
    // so people-search and LeadMagic actually get location + LinkedIn.
    const src: Record<string, unknown> = {
      ...(item.custom_variables ?? item.customVariables ?? {}),
      ...(item.payload ?? {}),
    };
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = src[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
      }
      return undefined;
    };

    return {
      email: leadEmail,
      first_name: item.first_name ?? pick("firstName", "first_name"),
      last_name: item.last_name ?? pick("lastName", "last_name"),
      company_name: item.company_name ?? pick("companyName", "company_name"),
      custom_variables: {
        location: pick("location"),
        city: pick("city"),
        state: pick("state"),
        company_industry: pick("company_industry", "industry"),
        linkedin_url: pick("linkedin_url", "linkedIn", "linkedin", "linkedInUrl"),
        company_phone: pick("company_phone", "companyPhone", "phone"),
      },
    };
  } catch (err) {
    console.error("lead lookup failed (non-fatal):", err);
    return null;
  }
}
