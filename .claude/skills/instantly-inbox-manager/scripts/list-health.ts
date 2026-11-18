#!/usr/bin/env tsx
/**
 * Inbox health dashboard — prints summary + optional CSV.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/list-health.ts --all
 *   npx tsx scripts/list-health.ts --tag=insurance --out=health.csv
 *   npx tsx scripts/list-health.ts --filter=reputation:good --out=good-inboxes.csv
 *   npx tsx scripts/list-health.ts --all --deep --out=health.csv
 *
 * Filters:
 *   --filter=reputation:good|fair|bad   (from stat_warmup_score: good>=80, fair>=50, bad<50)
 *   --filter=warmup:on|off
 *   --filter=health:healthy|warming|active|blocked|paused|connection_failed
 *
 * --deep: also calls POST /accounts/warmup-analytics (in batches of 50) and adds
 *   landed_inbox / landed_spam / health_score columns to the CSV.
 */

import { writeFileSync } from "fs";
import {
  parseFlag,
  selectInboxes,
  hasFlag,
  fetchJson,
  InboxAccount,
} from "./_lib";

interface HealthRow {
  email: string;
  domain: string;
  tags: string;
  warmup: string;
  warmup_score: number | "";
  warmup_limit: number | "";
  daily_limit: number | "";
  status: string;
  setup_pending: boolean;
  health_status: string;
  landed_inbox?: number | "";
  landed_spam?: number | "";
  health_score?: number | "";
}

// Account status: 1 Active, 2 Paused, -1 Connection Error, -2 Soft Ban, -3 Sending Error
function statusLabel(status: number | undefined): string {
  switch (status) {
    case 1: return "active";
    case 2: return "paused";
    case -1: return "connection_error";
    case -2: return "soft_ban";
    case -3: return "sending_error";
    default: return String(status ?? "unknown");
  }
}

function deriveHealth(a: InboxAccount): string {
  const status = a.status ?? 0;
  if (status !== 1) return status === 2 ? "paused" : "connection_failed";
  // warmup_status: 0 Paused, 1 Active, -1 Banned, -2 Spam Folder Unknown, -3 Permanent Suspension
  const ws = a.warmup_status ?? 0;
  if (ws < 0) return "blocked";
  const score = a.stat_warmup_score;
  if (score != null && score >= 80) return "healthy";
  if (ws === 1) return "warming"; // warmup active, score < 80 or not yet computed
  return "active"; // warmup off, account healthy and sending
}

function reputationOf(score: number | "" | null | undefined, warmupOn: boolean): string {
  if (score === "" || score == null) return warmupOn ? "unknown" : "n/a";
  if (score >= 80) return "good";
  if (score >= 50) return "fair";
  return "bad";
}

function inboxToHealthRow(a: InboxAccount): HealthRow {
  const email = a.email || "";
  const domain = email.split("@")[1] || "";
  const warmupOn = a.warmup_status === 1;
  return {
    email,
    domain,
    tags: (a.tags ?? []).map((t: any) => t?.label ?? String(t)).join(","),
    warmup: warmupOn ? "on" : "off",
    warmup_score: a.stat_warmup_score ?? "",
    warmup_limit: a.warmup?.limit ?? "",
    daily_limit: a.daily_limit ?? "",
    status: statusLabel(a.status),
    setup_pending: !!a.setup_pending,
    health_status: deriveHealth(a),
  };
}

function applyFilter(row: HealthRow, filter: string): boolean {
  const [k, v] = filter.split(":");
  if (k === "reputation") return reputationOf(row.warmup_score, row.warmup === "on") === v;
  if (k === "warmup") return row.warmup === v;
  if (k === "health") return row.health_status === v;
  throw new Error(`Unknown filter: ${filter}`);
}

function toCsv(rows: HealthRow[]): string {
  const header = Object.keys(rows[0] ?? {
    email: "", domain: "", tags: "", warmup: "", warmup_score: "", warmup_limit: "",
    daily_limit: "", status: "", setup_pending: "", health_status: "",
  });
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((h) => `"${String((row as any)[h]).replace(/"/g, '""')}"`).join(","));
  }
  return lines.join("\n");
}

/** Enrich rows with warmup-analytics data (batches of 50 emails per call). */
async function enrichDeep(rows: HealthRow[]): Promise<void> {
  const emails = rows.map((r) => r.email);
  const aggregate: Record<string, any> = {};
  for (let i = 0; i < emails.length; i += 50) {
    const batch = emails.slice(i, i + 50);
    console.error(`  warmup-analytics batch ${Math.floor(i / 50) + 1} (${batch.length} accounts)...`);
    const resp = await fetchJson(`/accounts/warmup-analytics`, {
      method: "POST",
      body: JSON.stringify({ emails: batch }),
    });
    Object.assign(aggregate, resp.aggregate_data ?? {});
  }
  for (const row of rows) {
    const agg = aggregate[row.email];
    row.landed_inbox = agg?.landed_inbox ?? "";
    row.landed_spam = agg?.landed_spam ?? "";
    row.health_score = agg?.health_score ?? "";
  }
}

async function main() {
  const args = process.argv.slice(2);
  const out = parseFlag(args, "--out");
  const filter = parseFlag(args, "--filter");
  const deep = hasFlag(args, "--deep");

  if (
    !hasFlag(args, "--all") &&
    !parseFlag(args, "--tag") &&
    !parseFlag(args, "--domain") &&
    !parseFlag(args, "--emails") &&
    !parseFlag(args, "--ids")
  ) {
    // default to --all for health dashboard
    args.push("--all");
  }

  const inboxes = await selectInboxes(args);
  let rows = inboxes.map(inboxToHealthRow);
  if (filter) rows = rows.filter((r) => applyFilter(r, filter));
  if (deep && rows.length) {
    console.error(`Fetching warmup analytics (--deep)...`);
    await enrichDeep(rows);
  }

  // Summary
  const total = rows.length;
  const warmupOn = rows.filter((r) => r.warmup === "on").length;
  const active = rows.filter((r) => r.warmup === "off").length;
  const blocked = rows.filter((r) => r.health_status === "blocked").length;
  const paused = rows.filter((r) => r.health_status === "paused").length;
  const failedConn = rows.filter((r) => r.health_status === "connection_failed").length;
  const setupPending = rows.filter((r) => r.setup_pending).length;
  const reps = rows.map((r) => reputationOf(r.warmup_score, r.warmup === "on"));
  const repGood = reps.filter((x) => x === "good").length;
  const repFair = reps.filter((x) => x === "fair").length;
  const repBad = reps.filter((x) => x === "bad").length;
  const repUnknown = reps.filter((x) => x === "unknown").length;

  console.log(`\nInbox Health Dashboard\n`);
  console.log(`Total inboxes: ${total}`);
  console.log(`  Warmup on:        ${warmupOn}`);
  console.log(`  Active (off):     ${active}`);
  console.log(`  Blocked:          ${blocked}`);
  console.log(`  Paused:           ${paused}`);
  console.log(`  Conn failed:      ${failedConn}`);
  console.log(`\nWarmup score (stat_warmup_score):`);
  console.log(`  Good (>=80):  ${repGood}`);
  console.log(`  Fair (>=50):  ${repFair}`);
  console.log(`  Bad (<50):    ${repBad}`);
  console.log(`  Unknown:      ${repUnknown}`);

  console.log(`\nAction items:`);
  if (blocked) console.log(`  - ${blocked} inboxes warmup-blocked — run /email-deliverability-audit`);
  if (repBad) console.log(`  - ${repBad} inboxes with bad warmup score — consider pausing`);
  if (failedConn) console.log(`  - ${failedConn} inboxes with connection/sending errors — reconnect or replace`);
  if (setupPending) console.log(`  - ${setupPending} inboxes with setup pending — finish setup in Instantly`);
  if (!blocked && !repBad && !failedConn && !setupPending) console.log(`  - None; everything looks healthy.`);

  if (out) {
    writeFileSync(out, toCsv(rows));
    console.log(`\nWrote CSV to ${out} (${rows.length} rows)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
