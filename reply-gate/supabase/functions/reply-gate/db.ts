// Thin Supabase REST client using the service role key. No SDK needed.
import { config } from "./config.ts";
import type { CampaignMapping, OfferSheet } from "./types.ts";

const headers = {
  apikey: config.supabaseServiceRoleKey,
  Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
  "Content-Type": "application/json",
};

async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function getOfferSheet(key: string): Promise<OfferSheet | null> {
  const rows = await rest(`/knowledge_base?key=eq.${encodeURIComponent(key)}&limit=1`);
  return rows?.[0] ?? null;
}

export async function getGlobalFacts(): Promise<string> {
  const rows = await rest(`/knowledge_base?is_global=eq.true&limit=1`);
  const facts: string = rows?.[0]?.offer_facts ?? "";
  // An unfinished global row must not leak placeholders into prompts.
  return facts.includes("FILL ME IN") ? "" : facts;
}

export async function getCampaignMapping(campaignId: string): Promise<CampaignMapping | null> {
  const rows = await rest(`/campaign_map?campaign_id=eq.${encodeURIComponent(campaignId)}&limit=1`);
  return rows?.[0] ?? null;
}

/**
 * Insert the log row for this (campaign, lead). Returns null if a row
 * already exists — the one-shot guard: we answer the first interested
 * reply and stay out of the conversation after that. Also makes
 * webhook retries harmless.
 */
export async function insertLogRow(row: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/replies_log`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation,resolution=ignore-duplicates" },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`insertLogRow → ${res.status}: ${text}`);
  const rows = text ? JSON.parse(text) : [];
  return rows[0]?.id ?? null;
}

export async function updateLogRow(id: string, patch: Record<string, unknown>): Promise<void> {
  await rest(`/replies_log?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function claimDueReplies(): Promise<any[]> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/claim_due_replies`, {
    method: "POST",
    headers,
    body: JSON.stringify({ max_rows: 10 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`claim_due_replies → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}
