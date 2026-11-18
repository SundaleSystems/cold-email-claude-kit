#!/usr/bin/env tsx
/**
 * Filter a MillionVerifier .verified.csv by email_status, KEEPING the status column.
 *
 * The send-ready final CSV drops email_status (Instantly rejects extra columns),
 * but /list-quality-scorecard needs that column to score verification coverage.
 * This produces the scorecard input: the same rows as the final list, with status.
 *
 * Usage:
 *   npx tsx .claude/skills/vayne-lead-pipeline/scripts/filter-status.ts \
 *     --file=Lead-Lists/3-Million-Verifier/<run-id>_merged.verified.csv \
 *     --out=Lead-Lists/3-Million-Verifier/<run-id>_ok-with-status.csv \
 *     [--status=ok]   (comma-separated list of statuses to keep; default ok)
 */

import fs from "node:fs";
import path from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const file = get("--file");
  const out = get("--out");
  if (!file || !out) {
    console.error("Usage: --file=<verified.csv> --out=<filtered.csv> [--status=ok]");
    process.exit(1);
  }
  return {
    file,
    out,
    statuses: (get("--status") ?? "ok").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { cur += c; }
    } else {
      if (c === '"') { inQuote = true; }
      else if (c === ",") { out.push(cur); cur = ""; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out;
}

function main() {
  const opts = parseArgs();
  const lines = fs.readFileSync(opts.file, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    console.error(`No rows in ${opts.file}.`);
    process.exit(1);
  }
  const headers = parseCsvLine(lines[0]);
  const statusIdx = headers.findIndex((h) => h.trim().toLowerCase() === "email_status");
  if (statusIdx === -1) {
    console.error(`No email_status column in ${opts.file}. Headers: ${headers.join(", ")}`);
    process.exit(1);
  }
  const kept = lines.slice(1).filter((line) => {
    const status = (parseCsvLine(line)[statusIdx] ?? "").trim().toLowerCase();
    return opts.statuses.includes(status);
  });
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, [lines[0], ...kept].join("\n") + "\n");
  console.error(`[filter] Kept ${kept.length}/${lines.length - 1} rows (status: ${opts.statuses.join(",")}) → ${opts.out}`);
}

main();
