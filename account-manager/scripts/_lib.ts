/**
 * Shared helpers for the account-manager scripts.
 * Zero dependencies. Loads the repo-root .env, wraps the Instantly API v2,
 * posts to Slack, parses CSV, and reads/writes the per-client runbook + state.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";

export const REPO_ROOT = resolve(__dirname, "..", "..");
export const AM_ROOT = resolve(REPO_ROOT, "account-manager");

// ---------- .env ----------
export function loadEnv(): void {
  const p = resolve(REPO_ROOT, ".env");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var: ${name} (set it in ${resolve(REPO_ROOT, ".env")})`);
    process.exit(1);
  }
  return v;
}

// ---------- args ----------
export function flag(name: string, def?: string): string | undefined {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}
export function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

// ---------- Instantly API v2 ----------
const API = "https://api.instantly.ai/api/v2";

export class ApiError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`${path} → ${status}: ${body.slice(0, 400)}`);
  }
}

export async function api(path: string, init: RequestInit = {}, attempts = 4): Promise<any> {
  const key = requireEnv("INSTANTLY_API_KEY");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "User-Agent": "cold-email-kit-account-manager/1.0",
        ...(init.headers ?? {}),
      },
    });
    if (res.ok) {
      const text = await res.text();
      try { return text ? JSON.parse(text) : {}; } catch { return text; }
    }
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new ApiError(res.status, path, body);
  }
}

export async function listAll(path: string): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  const out: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await api(`${path}${sep}limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
    const items = page.items ?? [];
    out.push(...items);
    if (!page.next_starting_after || items.length === 0) break;
    cursor = page.next_starting_after;
  }
  return out;
}

/** POST /leads/list paginated for one campaign. */
export async function listCampaignLeads(campaignId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await api("/leads/list", {
      method: "POST",
      body: JSON.stringify({ campaign: campaignId, limit: 100, ...(cursor ? { starting_after: cursor } : {}) }),
    });
    const items = page.items ?? [];
    out.push(...items);
    if (!page.next_starting_after || items.length === 0) break;
    cursor = page.next_starting_after;
  }
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const CAMPAIGN_STATUS: Record<number, string> = {
  0: "draft", 1: "active", 2: "paused", 3: "completed", 4: "running-subsequences",
  [-99]: "account-suspended", [-1]: "accounts-unhealthy", [-2]: "bounce-protect",
};

// ---------- Slack ----------
export async function slack(text: string, opts: { channel?: string } = {}): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = opts.channel ?? process.env.SLACK_ALERT_CHANNEL;
  if (!token || !channel) {
    console.log("[slack disabled — SLACK_BOT_TOKEN / SLACK_ALERT_CHANNEL missing]\n" + text);
    return false;
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!j.ok) console.error("Slack post failed:", j.error);
  return !!j.ok;
}

// ---------- CSV ----------
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const rows: string[][] = [];
  let cur = "", row: string[] = [], inQ = false;
  const src = text.replace(/\r\n/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return {
    headers,
    rows: rows.filter((r) => r.some((v) => v.trim().length)).map((r) => {
      const o: Record<string, string> = {};
      headers.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
      return o;
    }),
  };
}

export function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// ---------- runbook / state ----------
export interface LeadStock {
  id: string;
  path: string;
  status: "approved" | "hold" | "needs_copy" | "needs_personalization" | "needs_verification" | "used";
  verified?: string;
  /** ISO date the emails were last verified; approved stock older than targets.max_verification_age_days is demoted. */
  verified_date?: string;
  copy_source_campaign_id?: string;
  campaign_name?: string;
  column_map?: Record<string, string>;
  note?: string;
}

export interface Runbook {
  client: string;
  profile_dir: string;
  targets: {
    min_emails_per_day: number;
    avg_touches_per_lead: number;
    min_runway_days: number;
    max_bounce_rate_7d: number;
    min_warmup_score: number;
    max_daily_limit_step: number;
    max_verification_age_days?: number;
  };
  autonomy: {
    may_activate_campaigns: boolean;
    may_pause_campaigns: boolean;
    may_raise_daily_limit: boolean;
    may_add_leads_from_approved_stock: boolean;
    may_clone_campaign_from_approved_stock: boolean;
    may_create_draft_for_unapproved_stock: boolean;
    may_spend_on_lead_sourcing: boolean;
    max_leads_per_upload: number;
  };
  inbox_pool: { exclude_tags: string[]; min_status: number };
  ignore_campaign_ids: string[];
  /** Paused campaign ids the agent may attach inboxes to and resume when volume is short. */
  resume_allowlist?: string[];
  lead_stock: LeadStock[];
  slack_channel?: string;
}

export function clientDir(client: string): string {
  return resolve(AM_ROOT, "clients", client);
}

export function loadRunbook(client: string): Runbook {
  const p = resolve(clientDir(client), "runbook.json");
  if (!existsSync(p)) { console.error(`No runbook at ${p}`); process.exit(1); }
  return JSON.parse(readFileSync(p, "utf8"));
}

export function saveRunbook(client: string, rb: Runbook): void {
  writeFileSync(resolve(clientDir(client), "runbook.json"), JSON.stringify(rb, null, 2) + "\n");
}

export function today(tz = "America/New_York"): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
}

export function daysAgo(n: number, tz = "America/New_York"): string {
  const d = new Date(Date.now() - n * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

export function isWeekday(ymd: string): boolean {
  const d = new Date(ymd + "T12:00:00Z").getUTCDay();
  return d >= 1 && d <= 5;
}

export function writeState(client: string, name: string, data: unknown): string {
  const dir = resolve(clientDir(client), "state");
  mkdirSync(dir, { recursive: true });
  const p = resolve(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  return p;
}

export function readState(client: string, name: string): any | null {
  const p = resolve(clientDir(client), "state", `${name}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function appendOpsLog(client: string, entry: string): void {
  const p = resolve(clientDir(client), "ops-log.md");
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, entry.endsWith("\n") ? entry : entry + "\n");
}

export function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1)}%` : "n/a";
}
