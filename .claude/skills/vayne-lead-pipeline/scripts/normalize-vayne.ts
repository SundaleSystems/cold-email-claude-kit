#!/usr/bin/env tsx
/**
 * Normalize a raw Vayne export (CSV or JSON) into the canonical pipeline CSV.
 *
 * Vayne/LinkedIn exports use varying header names (firstName, profileUrl,
 * companyWebsite, …). This script auto-detects them, prints the mapping it
 * chose, and writes the canonical columns every downstream script expects.
 *
 * Usage:
 *   npx tsx .claude/skills/vayne-lead-pipeline/scripts/normalize-vayne.ts \
 *     --file=Lead-Lists/1-Vayne/<run-id>_vayne-raw.csv \
 *     --out=Lead-Lists/1-Vayne/<run-id>_vayne.csv
 *
 * Flags:
 *   --file=path   raw Vayne export, .csv or .json (required)
 *   --out=path    canonical CSV output (required)
 *   --map=...     override auto-detection, comma-separated canonical:source pairs,
 *                 e.g. --map=first_name:firstName,job_title:headline
 *                 (source names are matched case-insensitively)
 *
 * Canonical output columns:
 *   company_domain, first_name, last_name, job_title, linkedin_url, email,
 *   email_source, company_name, company_industry, company_headcount,
 *   company_phone, location, company_linkedin_url
 *
 * Always check the printed mapping report — if a column was mis-detected,
 * rerun with an explicit --map override.
 */

import fs from "node:fs";
import path from "node:path";

// ── args ────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const file = get("--file");
  const out = get("--out");
  if (!file || !out) {
    console.error("Usage: --file=<raw.csv|raw.json> --out=<canonical.csv> [--map=first_name:firstName,...]");
    process.exit(1);
  }
  const map: Record<string, string> = {};
  for (const pair of (get("--map") ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const colon = pair.indexOf(":");
    if (colon === -1) {
      console.error(`Bad --map entry "${pair}" — expected canonical:source`);
      process.exit(1);
    }
    map[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim();
  }
  return { file, out, map };
}

// ── CSV (minimal, handles quoted fields incl. embedded newlines) ────
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
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].map((h) => h.trim());
  const rows = records.slice(1).map((values) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

function escapeCsv(v: any): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── input loading (CSV or JSON array of objects) ────────────────────
function loadInput(file: string): { headers: string[]; rows: Record<string, string>[] } {
  const raw = fs.readFileSync(file, "utf8");
  if (file.toLowerCase().endsWith(".json") || raw.trimStart().startsWith("[") || raw.trimStart().startsWith("{")) {
    let data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      // Common wrappers: {results: [...]}, {data: [...]}, {leads: [...]}
      data = data.results ?? data.data ?? data.leads ?? data.items;
    }
    if (!Array.isArray(data)) {
      console.error("JSON input is not an array (and no results/data/leads/items wrapper found).");
      process.exit(1);
    }
    const headerSet = new Set<string>();
    const rows = data.map((obj: any) => {
      const row: Record<string, string> = {};
      for (const [k, v] of Object.entries(flatten(obj))) {
        row[k] = v == null ? "" : String(v);
        headerSet.add(k);
      }
      return row;
    });
    return { headers: [...headerSet], rows };
  }
  return parseCsv(raw);
}

// Flatten one level of nesting (e.g. {company: {name, website}} → "company.name").
function flatten(obj: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 == null || typeof v2 !== "object") out[`${k}.${k2}`] = v2;
      }
    } else if (!Array.isArray(v)) {
      out[k] = v;
    }
  }
  return out;
}

// ── header auto-detection ───────────────────────────────────────────
// Candidate source-header patterns per canonical column, most-specific first.
// Matching: exact (case/sep-insensitive) beats contains; earlier pattern beats later.
const CANDIDATES: Record<string, string[]> = {
  first_name: ["first_name", "firstname", "first"],
  last_name: ["last_name", "lastname", "last", "surname"],
  job_title: ["job_title", "jobtitle", "title", "headline", "position", "role"],
  linkedin_url: ["linkedin_url", "profile_url", "profileurl", "linkedin_profile", "linkedin", "profile_link", "navigation_url", "person_url"],
  email: ["email", "professional_email", "work_email", "email_address"],
  company_domain: ["company_domain", "companydomain", "company_website", "companywebsite", "website", "domain", "company_url"],
  company_name: ["company_name", "companyname", "company", "current_company", "organization"],
  company_industry: ["company_industry", "industry"],
  company_headcount: ["company_headcount", "headcount", "company_size", "companysize", "employees", "employee_count", "staff_count"],
  company_phone: ["company_phone", "phone", "phone_number"],
  location: ["location", "geo", "region", "city", "address"],
  // "corporate linkedin url" must outrank "company_linkedin" — Vayne exports also
  // carry a "company linkedin id" (URN) column that the looser pattern grabs first.
  company_linkedin_url: ["company_linkedin_url", "corporate_linkedin_url", "corporate_linkedin", "company_linkedin_page", "company_profile_url", "companyurl", "company_linkedin"],
};

const CANONICAL = [
  "company_domain", "first_name", "last_name", "job_title", "linkedin_url",
  "email", "email_source", "company_name", "company_industry",
  "company_headcount", "company_phone", "location", "company_linkedin_url",
];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function detectMapping(headers: string[], overrides: Record<string, string>): Record<string, string | null> {
  const mapping: Record<string, string | null> = {};
  const claimed = new Set<string>();
  const findHeader = (pattern: string, exact: boolean) =>
    headers.find((h) => !claimed.has(h) && (exact ? squash(h) === squash(pattern) : squash(h).includes(squash(pattern))));

  // Overrides claim first.
  for (const [canonical, source] of Object.entries(overrides)) {
    if (!CANONICAL.includes(canonical)) {
      console.error(`--map: "${canonical}" is not a canonical column. Valid: ${CANONICAL.join(", ")}`);
      process.exit(1);
    }
    const h = findHeader(source, true) ?? findHeader(source, false);
    if (!h) {
      console.error(`--map: source column "${source}" not found in input. Headers: ${headers.join(", ")}`);
      process.exit(1);
    }
    mapping[canonical] = h;
    claimed.add(h);
  }
  for (const canonical of CANONICAL) {
    if (canonical in mapping || canonical === "email_source") continue;
    let match: string | undefined;
    for (const exact of [true, false]) {
      for (const pattern of CANDIDATES[canonical] ?? []) {
        match = findHeader(pattern, exact);
        if (match) break;
      }
      if (match) break;
    }
    mapping[canonical] = match ?? null;
    if (match) claimed.add(match);
  }
  return mapping;
}

function cleanDomain(d: string): string {
  return (d || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .trim();
}

// ── main ────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs();
  const { headers, rows } = loadInput(opts.file);
  if (rows.length === 0) {
    console.error(`No rows in ${opts.file}.`);
    process.exit(1);
  }

  const mapping = detectMapping(headers, opts.map);

  console.error(`[normalize] ${rows.length} rows from ${opts.file}. Column mapping:`);
  for (const canonical of CANONICAL) {
    if (canonical === "email_source") continue;
    const src = mapping[canonical];
    console.error(`  ${canonical.padEnd(22)} ← ${src ?? "(not found — will be empty)"}`);
  }
  const missing = ["first_name", "last_name"].filter((c) => !mapping[c]);
  if (missing.length) {
    console.error(`\n[normalize] FATAL: could not detect ${missing.join(", ")}. Rerun with --map=${missing.map((m) => `${m}:<source-header>`).join(",")}`);
    process.exit(1);
  }

  const outRows = rows.map((r) => {
    const row: Record<string, string> = {};
    for (const canonical of CANONICAL) {
      if (canonical === "email_source") continue;
      const src = mapping[canonical];
      row[canonical] = src ? (r[src] ?? "").trim() : "";
    }
    row.company_domain = cleanDomain(row.company_domain);
    row.email_source = row.email.includes("@") ? "vayne" : "";
    if (!row.email.includes("@")) row.email = "";
    return row;
  });

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const out = [CANONICAL.join(",")];
  for (const r of outRows) out.push(CANONICAL.map((h) => escapeCsv(r[h])).join(","));
  fs.writeFileSync(opts.out, out.join("\n") + "\n");

  const withEmail = outRows.filter((r) => r.email).length;
  const withDomain = outRows.filter((r) => r.company_domain).length;
  console.error(`\n[normalize] Wrote ${opts.out} — ${outRows.length} rows, ${withEmail} with email (${((withEmail / outRows.length) * 100).toFixed(1)}%), ${withDomain} with company domain.`);
  if (withDomain / outRows.length < 0.5) {
    console.error(`[normalize] ⚠ Under 50% of rows have a company domain — LeadMagic hit rate will suffer. Check the company_domain mapping above.`);
  }
}

main();
