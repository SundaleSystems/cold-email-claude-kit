#!/usr/bin/env tsx
/**
 * Post-normalize trim + cross-run scrape registry for the Vayne pipeline.
 *
 * Runs AFTER normalize-vayne.ts, BEFORE LeadMagic. Does three things:
 *   1. REGISTER: appends every input row's linkedin_url to the scrape registry
 *      (Lead-Lists/scraped-registry.csv) so future runs know what's been paid for.
 *   2. DEDUPE: drops rows whose linkedin_url was already registered by a
 *      PREVIOUS run (protects LeadMagic/MV spend on re-scraped profiles).
 *   3. TRIM: drops rows that are clearly outside the ICP before any paid
 *      enrichment — excluded domains (from the client profile), headcount
 *      bands you name, industries you name.
 *
 * Trim choices are EXPLICIT flags, not auto-derived from the profile, because
 * soft edges are a judgment call (this workspace keeps 2-10 and 201-500 bands,
 * and keeps "Hospitality", per a 2026-07-22 run). Confirm with the user.
 *
 * Usage:
 *   npx tsx .claude/skills/vayne-lead-pipeline/scripts/trim-and-register.ts \
 *     --file=Lead-Lists/1-Vayne/<run-id>_vayne.csv \
 *     --run-id=<run-id> \
 *     --profile=profiles/<slug>/client-profile.yaml \
 *     --drop-headcounts="myself only,501-1000,1001-5000,5001-10000,10001+" \
 *     --drop-industries="Airlines and Aviation"
 *
 * Flags:
 *   --file=path            canonical CSV from normalize-vayne.ts (edited in place;
 *                          dropped rows go to <file base>-dropped.csv)
 *   --run-id=id            this run's id (recorded in the registry)
 *   --profile=path         client-profile.yaml — supplies excluded_domains
 *   --drop-headcounts=a,b  company_headcount values to drop (exact, case-insensitive)
 *   --drop-industries=a,b  company_industry values to drop (exact, case-insensitive)
 *   --registry=path        default Lead-Lists/scraped-registry.csv
 *   --no-register          skip registry append (e.g. re-running the trim)
 *   --dry-run              print what would happen, write nothing
 */

import fs from "node:fs";
import path from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const has = (flag: string) => args.includes(flag);
  const file = get("--file");
  const runId = get("--run-id");
  if (!file || !runId) {
    console.error('Usage: --file=<vayne.csv> --run-id=<id> [--profile=<yaml>] [--drop-headcounts="a,b"] [--drop-industries="a,b"] [--registry=path] [--no-register] [--dry-run]');
    process.exit(1);
  }
  const list = (s?: string) => (s ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return {
    file,
    runId,
    profile: get("--profile"),
    dropHeadcounts: new Set(list(get("--drop-headcounts"))),
    dropIndustries: new Set(list(get("--drop-industries"))),
    registry: get("--registry") ?? "Lead-Lists/scraped-registry.csv",
    register: !has("--no-register"),
    dryRun: has("--dry-run"),
  };
}

// Minimal CSV (same dialect as normalize-vayne.ts).
function parseCsv(raw: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let cur = "";
  let record: string[] = [];
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQuote) {
      if (c === '"' && raw[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { cur += c; }
    } else if (c === '"') { inQuote = true; }
    else if (c === ",") { record.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && raw[i + 1] === "\n") i++;
      record.push(cur); cur = "";
      if (record.some((v) => v.length > 0)) records.push(record);
      record = [];
    } else { cur += c; }
  }
  record.push(cur);
  if (record.some((v) => v.length > 0)) records.push(record);
  const headers = (records[0] ?? []).map((h) => h.trim());
  const rows = records.slice(1).map((values) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

function escapeCsv(v: any): string {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file: string, headers: string[], rows: Record<string, string>[]) {
  const out = [headers.join(",")];
  for (const r of rows) out.push(headers.map((h) => escapeCsv(r[h])).join(","));
  fs.writeFileSync(file, out.join("\n") + "\n");
}

const normUrl = (u: string) => (u || "").trim().toLowerCase().replace(/\/+$/, "");
const normDomain = (u: string) =>
  (u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].trim();

// excluded_domains from client-profile.yaml (naive block parse — matches the
// icp_hard_filters.excluded_domains list items, ignoring trailing comments).
function loadExcludedDomains(profilePath?: string): Set<string> {
  const out = new Set<string>();
  if (!profilePath) return out;
  const text = fs.readFileSync(profilePath, "utf8");
  const m = text.match(/excluded_domains:\s*\n((?:\s+-\s+.+\n?)+)/);
  if (m) {
    for (const line of m[1].split("\n")) {
      const item = line.replace(/^\s*-\s*/, "").split("#")[0].trim();
      if (item) out.add(normDomain(item));
    }
  }
  return out;
}

function main() {
  const opts = parseArgs();
  const { headers, rows } = parseCsv(fs.readFileSync(opts.file, "utf8"));
  if (!headers.includes("linkedin_url")) {
    console.error("[trim] FATAL: input has no linkedin_url column — run normalize-vayne.ts first.");
    process.exit(1);
  }
  const excludedDomains = loadExcludedDomains(opts.profile);

  // Previously registered profiles (from OTHER runs only — this run's own
  // registration must not drop its own rows on a re-run).
  const seenBefore = new Set<string>();
  const alreadyRegisteredThisRun = new Set<string>();
  if (fs.existsSync(opts.registry)) {
    const reg = parseCsv(fs.readFileSync(opts.registry, "utf8"));
    for (const r of reg.rows) {
      const url = normUrl(r.linkedin_url);
      if (!url) continue;
      if (r.run_id === opts.runId) alreadyRegisteredThisRun.add(url);
      else seenBefore.add(url);
    }
  }

  const kept: Record<string, string>[] = [];
  const dropped: (Record<string, string> & { drop_reason: string })[] = [];
  const reasons: Record<string, number> = {};
  for (const r of rows) {
    let reason = "";
    if (seenBefore.has(normUrl(r.linkedin_url))) reason = "already-scraped-previous-run";
    else if (excludedDomains.has(normDomain(r.company_domain))) reason = "excluded-domain";
    else if (opts.dropHeadcounts.has((r.company_headcount || "").trim().toLowerCase())) reason = `headcount:${r.company_headcount}`;
    else if (opts.dropIndustries.has((r.company_industry || "").trim().toLowerCase())) reason = `industry:${r.company_industry}`;
    if (reason) {
      dropped.push({ ...r, drop_reason: reason });
      reasons[reason.split(":")[0]] = (reasons[reason.split(":")[0]] ?? 0) + 1;
    } else kept.push(r);
  }

  console.error(`[trim] ${rows.length} rows in — kept ${kept.length}, dropped ${dropped.length}${dropped.length ? ` (${Object.entries(reasons).map(([k, v]) => `${k}: ${v}`).join(", ")})` : ""}`);

  if (opts.dryRun) {
    console.error("[trim] Dry run — nothing written.");
    return;
  }

  const droppedPath = opts.file.replace(/\.csv$/i, "") + "-dropped.csv";
  if (dropped.length) writeCsv(droppedPath, [...headers, "drop_reason"], dropped);
  writeCsv(opts.file, headers, kept);
  console.error(`[trim] Wrote ${opts.file} (${kept.length} rows)${dropped.length ? ` and ${droppedPath} (${dropped.length} rows)` : ""}`);

  if (opts.register) {
    fs.mkdirSync(path.dirname(opts.registry), { recursive: true });
    const isNew = !fs.existsSync(opts.registry);
    const today = new Date().toISOString().slice(0, 10);
    const lines: string[] = isNew ? ["linkedin_url,run_id,scraped_on"] : [];
    let added = 0;
    for (const r of rows) {
      const url = normUrl(r.linkedin_url);
      if (!url || alreadyRegisteredThisRun.has(url)) continue;
      alreadyRegisteredThisRun.add(url);
      lines.push([escapeCsv(r.linkedin_url), escapeCsv(opts.runId), today].join(","));
      added++;
    }
    if (lines.length) fs.appendFileSync(opts.registry, lines.join("\n") + "\n");
    console.error(`[trim] Registry: +${added} profiles → ${opts.registry}${added === 0 ? " (all already registered for this run)" : ""}`);
  }
}

main();
