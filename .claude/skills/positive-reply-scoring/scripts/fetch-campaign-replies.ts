#!/usr/bin/env tsx
/**
 * Fetch replies from an Instantly campaign for classification.
 *
 * Walks GET /api/v2/emails?campaign_id={id}&email_type=received paginated
 * (items / next_starting_after cursor), groups replies by lead email,
 * keeps only the FIRST (earliest) reply per lead, writes them to JSON.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/fetch-campaign-replies.ts --campaign-id=<uuid> --out=/tmp/replies.json
 *
 * Optional flags:
 *   --since=YYYY-MM-DD    Only replies after this date
 */

import { writeFileSync } from "fs";

const API_BASE = "https://api.instantly.ai";
const API_KEY = process.env.INSTANTLY_API_KEY;

if (!API_KEY) {
  console.error("Missing env var: INSTANTLY_API_KEY");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const campaignId = get("--campaign-id");
  const out = get("--out") ?? "/tmp/replies.json";
  const since = get("--since");
  if (!campaignId) {
    console.error("Usage: --campaign-id=<uuid> [--out=path] [--since=YYYY-MM-DD]");
    process.exit(1);
  }
  return { campaignId, out, since };
}

interface Reply {
  lead_id: string | number;
  email: string;
  lead_first_name: string;
  company: string;
  reply_time: string;
  reply_subject: string;
  reply_body: string;
  sequence_step: number;
  is_auto_reply: boolean;
}

async function fetchJson(url: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    });
    if (resp.status === 429 || resp.status >= 500) {
      const wait = 1000 * 2 ** attempt;
      console.error(`  [${resp.status}] retry in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    return resp.json();
  }
  throw new Error("Exhausted retries");
}

async function listReceivedEmails(campaignId: string): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  let page = 0;
  while (true) {
    const url = new URL(`${API_BASE}/api/v2/emails`);
    url.searchParams.set("campaign_id", campaignId);
    url.searchParams.set("email_type", "received");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("starting_after", cursor);
    const data = await fetchJson(url.toString());
    const items: any[] = data.items ?? [];
    all.push(...items);
    page++;
    console.error(`  page=${page} batch=${items.length} total=${all.length}`);
    if (!data.next_starting_after || items.length === 0) break;
    cursor = data.next_starting_after;
    // CRITICAL: GET /api/v2/emails is rate-limited to 20 requests/minute.
    // Sleep >=3200ms between page requests to stay under the limit.
    await new Promise((r) => setTimeout(r, 3200));
  }
  return all;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const { campaignId, out, since } = parseArgs();
  console.error(`Fetching received emails for campaign ${campaignId}...`);
  const emails = await listReceivedEmails(campaignId);
  console.error(`Fetched ${emails.length} received emails. Grouping by lead...`);

  const sinceDate = since ? new Date(since) : null;

  // Group by lead email, keep only the EARLIEST reply per lead
  // ("classify only FIRST reply per lead" — later messages are the
  // conversation, not the scoring signal).
  // Auto-replies are NOT skipped here: the classification taxonomy
  // handles OOO/bounce itself; is_auto_reply is passed along as a hint.
  const firstByLead = new Map<string, any>();
  for (const e of emails) {
    const leadEmail = e.lead;
    if (!leadEmail) continue;
    const existing = firstByLead.get(leadEmail);
    if (
      !existing ||
      new Date(e.timestamp_email || 0) < new Date(existing.timestamp_email || 0)
    ) {
      firstByLead.set(leadEmail, e);
    }
  }
  console.error(`  ${firstByLead.size} leads with replies`);

  const replies: Reply[] = [];
  for (const [leadEmail, e] of firstByLead) {
    const replyTime = e.timestamp_email || e.timestamp_created || "";
    if (sinceDate && replyTime && new Date(replyTime) < sinceDate) continue;
    const rawBody = e.body?.text ?? (e.body?.html ? stripHtml(e.body.html) : "");
    replies.push({
      lead_id: e.lead_id ?? leadEmail,
      email: leadEmail,
      lead_first_name: "",
      company: "",
      reply_time: replyTime,
      reply_subject: e.subject || "",
      reply_body: String(rawBody).slice(0, 5000),
      sequence_step: Number(e.step) || 0,
      is_auto_reply: e.is_auto_reply === 1,
    });
  }

  writeFileSync(out, JSON.stringify(replies, null, 2));
  console.error(`\nWrote ${out} — ${replies.length} replies`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
