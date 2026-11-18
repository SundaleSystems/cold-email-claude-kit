#!/usr/bin/env tsx
/**
 * Campaign + per-inbox sent + reply + bounce audit (Instantly API v2).
 *
 * Applies the 1% rule:
 *   - flag_low_reply = TRUE if sent >= 200 AND reply_rate < 1%
 *   - flag_high_bounce = TRUE if sent >= 50 AND bounce_rate > 3%
 *
 * Two output files:
 *   1. <out>-campaigns.csv — campaign-level aggregates (authoritative for 1% rule)
 *   2. <out>-inboxes.csv    — per-inbox stats from account daily analytics
 *
 * Note: Instantly's per-account analytics span ALL campaigns (there is no
 * per-campaign-per-inbox breakdown endpoint). The 1%-rule flags in the inbox
 * CSV are therefore per inbox across campaigns — which matches the rule's
 * intent: it's the inbox/domain that carries the reputation, not the campaign.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/audit-performance.ts --days=30 --out=/tmp/audit/performance
 *   npx tsx scripts/audit-performance.ts --campaign-ids=uuid1,uuid2 --out=/tmp/audit/perf
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const API_BASE = "https://api.instantly.ai";
const API_KEY = process.env.INSTANTLY_API_KEY;
if (!API_KEY) {
  console.error("Missing env: INSTANTLY_API_KEY");
  process.exit(1);
}

const LOW_REPLY_THRESHOLD = 1.0; // percent
const LOW_REPLY_MIN_SENT = 200;
const HIGH_BOUNCE_THRESHOLD = 3.0;
const HIGH_BOUNCE_MIN_SENT = 50;

// Campaign status codes: 0 Draft, 1 Active, 2 Paused, 3 Completed,
// 4 Running Subsequences, -99 Suspended, -1 Accounts Unhealthy, -2 Bounce Protect.
// We audit Active/Paused/Completed (Draft excluded — it has sent nothing).
const AUDITABLE_STATUSES = [1, 2, 3];
const STATUS_NAMES: Record<number, string> = {
  0: "DRAFT",
  1: "ACTIVE",
  2: "PAUSED",
  3: "COMPLETED",
  4: "RUNNING_SUBSEQUENCES",
  [-99]: "SUSPENDED",
  [-1]: "ACCOUNTS_UNHEALTHY",
  [-2]: "BOUNCE_PROTECT",
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  return {
    days: get("--days") ? Number(get("--days")) : 30,
    out: get("--out") ?? "/tmp/audit/performance",
    maxCampaigns: get("--max-campaigns") ? Number(get("--max-campaigns")) : Infinity,
    campaignIds: get("--campaign-ids")?.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

async function fetchJson(path: string, init: RequestInit = {}, attempts = 4): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (resp.ok) return resp.json();
    if ((resp.status === 429 || resp.status >= 500) && attempt < attempts) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const t = await resp.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} → ${resp.status}: ${t.slice(0, 200)}`);
  }
}

async function listCampaigns(): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const qs = `limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`;
    const page = await fetchJson(`/api/v2/campaigns?${qs}`);
    const items = page.items ?? [];
    if (!items.length) break;
    all.push(...items);
    if (!page.next_starting_after) break;
    cursor = page.next_starting_after;
  }
  return all;
}

async function campaignAnalytics(id: string, startDate: string, endDate: string): Promise<any> {
  const data = await fetchJson(
    `/api/v2/campaigns/analytics?id=${encodeURIComponent(id)}&start_date=${startDate}&end_date=${endDate}`
  );
  // Returns an array (one entry per campaign) — we asked for a single id.
  return Array.isArray(data) ? data[0] : data;
}

async function accountDailyAnalytics(startDate: string, endDate: string): Promise<any[]> {
  const data = await fetchJson(
    `/api/v2/accounts/analytics/daily?start_date=${startDate}&end_date=${endDate}`
  );
  return Array.isArray(data) ? data : [];
}

interface CampaignRow {
  campaign_id: string;
  name: string;
  status: string;
  sent: number;
  replies: number;
  bounces: number;
  reply_rate_pct: number;
  bounce_rate_pct: number;
  flag_low_reply: boolean;
  flag_high_bounce: boolean;
}

interface InboxRow {
  email: string;
  domain: string;
  sent: number;
  replies: number;
  bounces: number;
  reply_rate_pct: number;
  bounce_rate_pct: number;
  flag_low_reply: boolean;
  flag_high_bounce: boolean;
}

function toCsv<T>(rows: T[], headers: string[]): string {
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      headers
        .map((h) => `"${String((r as any)[h] ?? "").replace(/"/g, '""')}"`)
        .join(",")
    );
  }
  return lines.join("\n");
}

async function main() {
  const { days, out, maxCampaigns, campaignIds } = parseArgs();
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  console.error(`Lookback window: ${startDate} → ${endDate} (${days} days)`);

  // 1. Pick campaigns
  let campaigns: any[];
  if (campaignIds?.length) {
    campaigns = campaignIds.map((id) => ({ id, name: `(campaign ${id})`, status: null }));
    console.error(`${campaigns.length} campaigns (from --campaign-ids)`);
  } else {
    const all = await listCampaigns();
    campaigns = all.filter((c) => AUDITABLE_STATUSES.includes(c.status));
    if (isFinite(maxCampaigns)) campaigns = campaigns.slice(0, maxCampaigns);
    console.error(`${campaigns.length} active/paused/completed campaigns`);
  }

  // 2. Campaign-level aggregates (1% rule at campaign level)
  const campaignRows: CampaignRow[] = [];
  console.error("\n=== Campaign-level stats ===");
  for (let i = 0; i < campaigns.length; i++) {
    const c = campaigns[i];
    try {
      const a = await campaignAnalytics(c.id, startDate, endDate);
      const sent = Number(a?.emails_sent_count ?? 0);
      // reply_count_unique = first reply per lead, excludes auto-replies —
      // the closest match to per-lead reply semantics used by the 1% rule.
      const replies = Number(a?.reply_count_unique ?? 0);
      const bounces = Number(a?.bounced_count ?? 0);
      const replyRate = sent ? (replies / sent) * 100 : 0;
      const bounceRate = sent ? (bounces / sent) * 100 : 0;
      const statusCode = c.status ?? a?.campaign_status;
      campaignRows.push({
        campaign_id: c.id,
        name: a?.campaign_name || c.name || "",
        status: STATUS_NAMES[statusCode as number] ?? String(statusCode ?? ""),
        sent,
        replies,
        bounces,
        reply_rate_pct: Number(replyRate.toFixed(2)),
        bounce_rate_pct: Number(bounceRate.toFixed(2)),
        flag_low_reply: sent >= LOW_REPLY_MIN_SENT && replyRate < LOW_REPLY_THRESHOLD,
        flag_high_bounce: sent >= HIGH_BOUNCE_MIN_SENT && bounceRate > HIGH_BOUNCE_THRESHOLD,
      });
      if ((i + 1) % 10 === 0)
        console.error(`  ${i + 1}/${campaigns.length} analytics pulled`);
    } catch (err) {
      console.error(`  campaign ${c.id} analytics error: ${String(err).slice(0, 100)}`);
    }
  }
  campaignRows.sort((a, b) => b.sent - a.sent);

  // 3. Per-inbox aggregation from account daily analytics.
  // These stats span ALL campaigns for each inbox (Instantly has no
  // per-campaign-per-inbox endpoint) — which is exactly what the 1% rule
  // wants: inbox/domain health, regardless of which campaign did the sending.
  console.error("\n=== Per-inbox aggregation (account daily analytics) ===");
  const inboxAgg = new Map<
    string,
    { sent: number; replies: number; bounces: number }
  >();
  try {
    const daily = await accountDailyAnalytics(startDate, endDate);
    for (const d of daily) {
      const email = d.email_account;
      if (!email) continue;
      if (!inboxAgg.has(email)) inboxAgg.set(email, { sent: 0, replies: 0, bounces: 0 });
      const agg = inboxAgg.get(email)!;
      agg.sent += Number(d.sent ?? 0);
      agg.replies += Number(d.unique_replies ?? 0);
      agg.bounces += Number(d.bounced ?? 0);
    }
  } catch (err) {
    console.error(`  account analytics error: ${String(err).slice(0, 100)}`);
  }
  const inboxRows: InboxRow[] = [];
  for (const [email, agg] of inboxAgg) {
    const replyRate = agg.sent ? (agg.replies / agg.sent) * 100 : 0;
    const bounceRate = agg.sent ? (agg.bounces / agg.sent) * 100 : 0;
    inboxRows.push({
      email,
      domain: email.split("@")[1] || "",
      sent: agg.sent,
      replies: agg.replies,
      bounces: agg.bounces,
      reply_rate_pct: Number(replyRate.toFixed(2)),
      bounce_rate_pct: Number(bounceRate.toFixed(2)),
      flag_low_reply: agg.sent >= LOW_REPLY_MIN_SENT && replyRate < LOW_REPLY_THRESHOLD,
      flag_high_bounce: agg.sent >= HIGH_BOUNCE_MIN_SENT && bounceRate > HIGH_BOUNCE_THRESHOLD,
    });
  }
  inboxRows.sort((a, b) => b.sent - a.sent);

  // 4. Write CSVs
  mkdirSync(dirname(out), { recursive: true });
  const campaignHeaders = [
    "campaign_id",
    "name",
    "status",
    "sent",
    "replies",
    "bounces",
    "reply_rate_pct",
    "bounce_rate_pct",
    "flag_low_reply",
    "flag_high_bounce",
  ];
  writeFileSync(`${out}-campaigns.csv`, toCsv(campaignRows, campaignHeaders));
  const inboxHeaders = [
    "email",
    "domain",
    "sent",
    "replies",
    "bounces",
    "reply_rate_pct",
    "bounce_rate_pct",
    "flag_low_reply",
    "flag_high_bounce",
  ];
  writeFileSync(`${out}-inboxes.csv`, toCsv(inboxRows, inboxHeaders));

  // 5. Summary
  const totalSent = campaignRows.reduce((s, c) => s + c.sent, 0);
  const totalReplies = campaignRows.reduce((s, c) => s + c.replies, 0);
  const totalBounces = campaignRows.reduce((s, c) => s + c.bounces, 0);
  const fleetReply = totalSent ? (totalReplies / totalSent) * 100 : 0;
  const fleetBounce = totalSent ? (totalBounces / totalSent) * 100 : 0;
  const camp1pct = campaignRows.filter((c) => c.flag_low_reply).length;
  const campHiBounce = campaignRows.filter((c) => c.flag_high_bounce).length;
  const inb1pct = inboxRows.filter((r) => r.flag_low_reply).length;

  console.log(`\n=== Fleet Performance Summary ===\n`);
  console.log(`Campaigns audited:       ${campaignRows.length}`);
  console.log(`Total sent:              ${totalSent.toLocaleString()}`);
  console.log(`Total replies:           ${totalReplies.toLocaleString()}`);
  console.log(`Total bounces:           ${totalBounces.toLocaleString()}`);
  console.log(`Fleet reply rate:        ${fleetReply.toFixed(2)}%  ${fleetReply >= 1 ? "PASS" : "FAIL (below 1%)"}`);
  console.log(`Fleet bounce rate:       ${fleetBounce.toFixed(2)}%  ${fleetBounce <= 2 ? "PASS" : "FAIL (above 2%)"}`);
  console.log(`\nCampaigns failing 1% rule (≥200 sent, <1% reply):   ${camp1pct}`);
  console.log(`Campaigns with bounce >3% (≥50 sent):                  ${campHiBounce}`);
  console.log(`Inboxes (aggregated) failing 1% rule:                  ${inb1pct}`);

  const offenders = campaignRows.filter((c) => c.flag_low_reply).slice(0, 10);
  if (offenders.length) {
    console.log(`\nTop campaigns failing the 1% rule:`);
    console.log(`id                                    sent     reply%   name`);
    for (const o of offenders) {
      console.log(
        `${String(o.campaign_id).padEnd(37)} ${String(o.sent).padStart(5)}    ${String(o.reply_rate_pct).padStart(5)}%   ${o.name.slice(0, 60)}`
      );
    }
  }

  console.log(`\nOutputs:`);
  console.log(`  ${out}-campaigns.csv  (authoritative — use this for 1% rule)`);
  console.log(`  ${out}-inboxes.csv    (per-inbox aggregation across all campaigns)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
