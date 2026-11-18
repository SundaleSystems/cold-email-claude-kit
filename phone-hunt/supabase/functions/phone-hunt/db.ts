// Thin Supabase REST client using the service role key. No SDK needed.
// Ported from reply-gate's db.ts, trimmed to the two operations this
// pipeline needs.
import { config } from "./config.ts";

const headers = {
  apikey: config.supabaseServiceRoleKey,
  Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
  "Content-Type": "application/json",
};

/**
 * Insert the log row for this (campaign, lead). Returns null if a row
 * already exists — the one-shot guard: hunt once per interested lead,
 * and make webhook retries / a second positive event harmless.
 */
export async function insertLogRow(row: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/phone_hunt_log`, {
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
  const res = await fetch(`${config.supabaseUrl}/rest/v1/phone_hunt_log?id=eq.${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`updateLogRow → ${res.status}: ${text}`);
}
