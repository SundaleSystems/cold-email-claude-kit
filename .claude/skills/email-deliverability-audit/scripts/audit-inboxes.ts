#!/usr/bin/env tsx
/**
 * Pull inbox inventory from Instantly and write to CSV.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/audit-inboxes.ts --all --out=/tmp/audit/inboxes.csv
 *   npx tsx scripts/audit-inboxes.ts --tag=active --out=/tmp/audit/active.csv
 *   npx tsx scripts/audit-inboxes.ts --all --vitals --out=/tmp/audit/inboxes.csv
 *
 * Field mapping vs the account object (see /instantly-api):
 *   - email                    → `email`
 *   - from_name                → `first_name` + `last_name`
 *   - status: 1 Active, 2 Paused, -1 Connection Error, -2 Soft Ban, -3 Sending Error
 *   - warmup_status: 1 Active, 0 Paused, negative = blocked/banned
 *   - warmup_reputation        → `stat_warmup_score` (0-100, higher is better)
 *   - max_warmup_per_day       → `warmup.limit`
 *   - message_per_day          → `daily_limit`
 *   - daily_sent_count         → summed from GET /accounts/analytics/daily (today)
 *   - --vitals adds a DNS check column via POST /accounts/test/vitals (SPF/DKIM/DMARC/MX)
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

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
  return {
    all: args.includes("--all"),
    vitals: args.includes("--vitals"),
    tag: get("--tag"),
    domain: get("--domain"),
    maxInboxes: get("--max-inboxes") ? Number(get("--max-inboxes")) : Infinity,
    out: get("--out") ?? "/tmp/audit/inboxes.csv",
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
    throw new Error(`${init.method ?? "GET"} ${path} → ${resp.status}: ${await resp.text().catch(() => "")}`);
  }
}

async function listAll(maxInboxes: number = Infinity): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const qs = `limit=100&include_tags=true${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`;
    const page = await fetchJson(`/api/v2/accounts?${qs}`);
    const items = page.items ?? [];
    if (!items.length) break;
    all.push(...items);
    console.error(`  total_so_far=${all.length}`);
    if (all.length >= maxInboxes) {
      all.length = Math.min(all.length, maxInboxes);
      break;
    }
    if (!page.next_starting_after) break;
    cursor = page.next_starting_after;
  }
  return all;
}

/** Sum today's `sent` per email_account from the daily account analytics. */
async function dailySentByAccount(): Promise<Map<string, number>> {
  const today = new Date().toISOString().slice(0, 10);
  const map = new Map<string, number>();
  try {
    const rows = await fetchJson(`/api/v2/accounts/analytics/daily?start_date=${today}&end_date=${today}`);
    for (const r of Array.isArray(rows) ? rows : []) {
      const key = r.email_account;
      if (!key) continue;
      map.set(key, (map.get(key) ?? 0) + Number(r.sent ?? 0));
    }
  } catch (err) {
    console.error(`  daily analytics unavailable: ${String(err).slice(0, 120)}`);
  }
  return map;
}

/**
 * DNS vitals per domain via POST /api/v2/accounts/test/vitals (batched ~50 emails).
 * Returns domain → failing checks string ("" = all pass).
 */
async function dnsVitalsByDomain(emails: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < emails.length; i += 50) {
    const batch = emails.slice(i, i + 50);
    try {
      const res = await fetchJson(`/api/v2/accounts/test/vitals`, {
        method: "POST",
        body: JSON.stringify({ accounts: batch }),
      });
      for (const d of [...(res.success_list ?? []), ...(res.failure_list ?? [])]) {
        const failing: string[] = [];
        if (d.spf === false) failing.push("SPF");
        if (d.dkim === false) failing.push("DKIM");
        if (d.dmarc === false) failing.push("DMARC");
        if (d.mx === false) failing.push("MX");
        map.set(d.domain, failing.join("|"));
      }
      console.error(`  vitals ${Math.min(i + 50, emails.length)}/${emails.length}`);
    } catch (err) {
      console.error(`  vitals batch error: ${String(err).slice(0, 120)}`);
    }
  }
  return map;
}

function tagLabels(i: any): string[] {
  return (i.tags ?? []).map((t: any) => t?.label ?? t?.name ?? String(t)).filter(Boolean);
}

function rowFor(i: any, sentToday: Map<string, number>, vitals?: Map<string, string>) {
  const email = i.email || "";
  const domain = email.split("@")[1] || "";
  const from_name = [i.first_name, i.last_name].filter(Boolean).join(" ");
  const row: Record<string, any> = {
    email,
    domain,
    from_name,
    tags: tagLabels(i).join("|"),
    status: i.status ?? "",
    is_connected: i.status === 1,
    warmup_status: i.warmup_status ?? "",
    warmup_reputation: i.stat_warmup_score ?? "",
    max_warmup_per_day: i.warmup?.limit ?? "",
    is_warmup_blocked: typeof i.warmup_status === "number" && i.warmup_status < 0,
    message_per_day: i.daily_limit ?? "",
    daily_sent_count: sentToday.get(email) ?? 0,
    provider_code: i.provider_code ?? "",
  };
  if (vitals) {
    const failing = vitals.get(domain);
    row.dns_failing = failing ?? "";
    row.flag_dns = !!failing;
  }
  return row;
}

async function main() {
  const { all: wantAll, tag, domain, out, maxInboxes, vitals: wantVitals } = parseArgs();
  let inboxes = await listAll(maxInboxes);
  if (tag) inboxes = inboxes.filter((i) => tagLabels(i).includes(tag));
  if (domain) inboxes = inboxes.filter((i) => (i.email || "").endsWith(`@${domain}`));
  if (!wantAll && !tag && !domain) {
    console.error("Provide --all, --tag=..., or --domain=...");
    process.exit(1);
  }
  const sentToday = await dailySentByAccount();
  let vitals: Map<string, string> | undefined;
  if (wantVitals) {
    console.error("Running DNS vitals check...");
    vitals = await dnsVitalsByDomain(inboxes.map((i) => i.email).filter(Boolean));
  }
  const rows = inboxes.map((i) => rowFor(i, sentToday, vitals));
  if (!rows.length) {
    console.error("No inboxes matched.");
    return;
  }
  const header = Object.keys(rows[0]);
  const csv = [header.join(",")];
  for (const r of rows) {
    csv.push(header.map((h) => `"${String((r as any)[h]).replace(/"/g, '""')}"`).join(","));
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, csv.join("\n"));
  console.error(`Wrote ${out} — ${rows.length} inboxes`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
