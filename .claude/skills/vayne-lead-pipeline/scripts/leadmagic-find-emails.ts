#!/usr/bin/env tsx
/**
 * Find work emails via LeadMagic for leads that came out of Vayne without one,
 * then merge the found rows back with the rows that already had emails.
 *
 * Pipeline: read CSV → partition (has-email / lookup / insufficient-data) →
 * LeadMagic email-finder per lookup row → write found / no-email / errors CSVs
 * → merge passthrough + found (deduped) into the MillionVerifier input.
 *
 * Usage:
 *   npx tsx .claude/skills/vayne-lead-pipeline/scripts/leadmagic-find-emails.ts \
 *     --file=Lead-Lists/1-Vayne/<run-id>_vayne.csv \
 *     --out-merged=Lead-Lists/3-Million-Verifier/<run-id>_merged.csv
 *
 * Flags:
 *   --file=path            input CSV (required; canonical pipeline columns)
 *   --out-found=path       default: Lead-Lists/2-Lead-Magic/<base>_leadmagic-found.csv
 *   --out-no-email=path    default: Lead-Lists/2-Lead-Magic/<base>_no-email.csv
 *   --out-errors=path      default: Lead-Lists/2-Lead-Magic/<base>_errors.csv
 *   --out-merged=path      default: Lead-Lists/3-Million-Verifier/<base>_merged.csv
 *   --progress-file=path   default: Lead-Lists/2-Lead-Magic/<base>_progress.jsonl
 *   --concurrency=5        parallel LeadMagic requests
 *   --limit=N              only attempt the first N lookups (testing)
 *   --dry-run              print partition counts + credit balance, spend nothing
 *   --resume               skip lookups already recorded in the progress journal
 *
 * Cost: 1 LeadMagic credit per FOUND email, 0 if not found.
 * Any email LeadMagic returns is accepted regardless of its own status —
 * MillionVerifier re-verifies everything downstream (--keep=ok).
 *
 * Requires LEADMAGIC_API_KEY (repo-root .env or exported).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── env (repo-root .env, no dotenv dependency) ──────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function findEnvFile(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const cwdEnv = path.resolve(process.cwd(), ".env");
  return fs.existsSync(cwdEnv) ? cwdEnv : null;
}
function loadEnv(): Record<string, string> {
  const envPath = findEnvFile();
  const out: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (!envPath) return out;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!out[key]) out[key] = val;
  }
  return out;
}
const env = loadEnv();
const API_KEY = env.LEADMAGIC_API_KEY;
if (!API_KEY) {
  console.error("Missing env: LEADMAGIC_API_KEY. Add it to .env (see .env.example).");
  process.exit(1);
}

const BASE = env.LEADMAGIC_BASE_URL || "https://api.leadmagic.io";

// ── args ────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const file = get("--file");
  if (!file) {
    console.error("Usage: --file=<vayne.csv> [--out-merged=path] [--concurrency=5] [--limit=N] [--dry-run] [--resume]");
    process.exit(1);
  }
  // <base> = input filename without extension and without a trailing "_vayne" suffix.
  const base = path.basename(file).replace(/\.csv$/i, "").replace(/_vayne$/i, "");
  const lmDir = "Lead-Lists/2-Lead-Magic";
  const mvDir = "Lead-Lists/3-Million-Verifier";
  return {
    file,
    outFound: get("--out-found") ?? path.join(lmDir, `${base}_leadmagic-found.csv`),
    outNoEmail: get("--out-no-email") ?? path.join(lmDir, `${base}_no-email.csv`),
    outErrors: get("--out-errors") ?? path.join(lmDir, `${base}_errors.csv`),
    outMerged: get("--out-merged") ?? path.join(mvDir, `${base}_merged.csv`),
    progressFile: get("--progress-file") ?? path.join(lmDir, `${base}_progress.jsonl`),
    concurrency: Number(get("--concurrency") ?? 10),
    limit: get("--limit") ? Number(get("--limit")) : undefined,
    dryRun: args.includes("--dry-run"),
    resume: args.includes("--resume"),
  };
}

// ── CSV (minimal, handles quoted fields) ────────────────────────────
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

function readCsv(filepath: string): { headers: string[]; rows: Record<string, string>[] } {
  const raw = fs.readFileSync(filepath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
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

function writeCsv(filepath: string, headers: string[], rows: Record<string, string>[]): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const out = [headers.join(",")];
  for (const r of rows) out.push(headers.map((h) => escapeCsv(r[h])).join(","));
  fs.writeFileSync(filepath, out.join("\n") + "\n");
}

// ── HTTP ────────────────────────────────────────────────────────────
class FatalApiError extends Error {}

async function leadmagicPost(pathName: string, body: any, attempts = 4): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${BASE}${pathName}`, {
      method: "POST",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch((e) => {
      if (attempt < attempts) return null;
      throw e;
    });
    if (resp && resp.ok) return resp.json();
    if (resp && (resp.status === 401 || resp.status === 403)) {
      throw new FatalApiError(`Auth failed (HTTP ${resp.status}) — check LEADMAGIC_API_KEY.`);
    }
    if (resp && resp.status === 402) {
      throw new FatalApiError("LeadMagic credits exhausted (HTTP 402). Top up at https://leadmagic.io/");
    }
    if (resp && resp.status < 500 && resp.status !== 429) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    if (attempt >= attempts) {
      throw new Error(`HTTP ${resp?.status ?? "network error"} after ${attempts + 1} attempts`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function getCredits(): Promise<string> {
  try {
    const resp = await fetch(`${BASE}/v1/credits`, {
      method: "GET",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    });
    if (!resp.ok) return `(credits check failed: HTTP ${resp.status})`;
    const data = await resp.json();
    const n = data.credits ?? data.credit ?? data.balance;
    return n != null ? String(n) : JSON.stringify(data).slice(0, 120);
  } catch (e) {
    return `(credits check failed: ${String(e).slice(0, 80)})`;
  }
}

// ── domain / key helpers ────────────────────────────────────────────
function cleanDomain(d: string): string {
  return (d || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .trim();
}

// LinkedIn name fields often carry junk the email-finder 400s on: quoted
// nicknames (Dilshad "dd"), taglines after " - ", emoji, business names stuffed
// into the name columns. Clean what's cleanable; reject what isn't a person name.
const BUSINESS_NAME = /\b(llc|inc|ltd|corp|company|travel|vacations?|agency|agencies|tours?|charters?|cruises?|group|realty|services|consulting|expert|official)\b/i;

function sanitizeName(name: string): string {
  return (name || "")
    .replace(/["“”'']+[^"“”'']*["“”'']+/g, " ") // quoted nicknames
    .replace(/\(.*?\)/g, " ")
    // taglines: `Name - the crm expert`, `Ruff, ceo at travel cafe`. Hyphen only
    // splits when space-surrounded so hyphenated surnames survive.
    .split(/\s*[|,–—]\s+|\s+-\s+/)[0]
    .replace(/[^\p{L}\p{M}.\-' ]/gu, " ") // emoji, digits, symbols
    .replace(/\s+/g, " ")
    .trim();
}

function validPersonName(first: string, last: string): boolean {
  if (first.length < 2 || last.length < 2) return false; // API rejects initials
  if (first.length > 40 || last.length > 40) return false;
  if (BUSINESS_NAME.test(`${first} ${last}`)) return false;
  return true;
}

function rowKey(r: Record<string, string>): string {
  const li = (r.linkedin_url || "").trim().toLowerCase().replace(/\/+$/, "");
  if (li) return li;
  return [
    (r.first_name || "").trim().toLowerCase(),
    (r.last_name || "").trim().toLowerCase(),
    cleanDomain(r.company_domain) || (r.company_name || "").trim().toLowerCase(),
  ].join("|");
}

// ── concurrency pool ────────────────────────────────────────────────
async function pool<T>(items: T[], concurrency: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// ── main ────────────────────────────────────────────────────────────
type Journal = Map<string, { outcome: string; email?: string; leadmagic_status?: string }>;

function loadJournal(file: string): Journal {
  const journal: Journal = new Map();
  if (!fs.existsSync(file)) return journal;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.key) journal.set(entry.key, entry);
    } catch { /* torn write on crash — at most the final line; ignore */ }
  }
  return journal;
}

async function main() {
  const opts = parseArgs();
  const { headers, rows } = readCsv(opts.file);
  if (rows.length === 0) {
    console.error(`No rows in ${opts.file}.`);
    process.exit(1);
  }
  for (const required of ["first_name", "last_name", "email"]) {
    if (!headers.includes(required)) {
      console.error(`Column "${required}" not found in ${opts.file}. Headers: ${headers.join(", ")}`);
      process.exit(1);
    }
  }

  // Partition.
  const passthrough: Record<string, string>[] = [];
  const lookup: Record<string, string>[] = [];
  const noEmail: Record<string, string>[] = [];
  for (const r of rows) {
    if ((r.email || "").includes("@")) {
      if (!r.email_source) r.email_source = "vayne";
      passthrough.push(r);
      continue;
    }
    const first = sanitizeName(r.first_name);
    const last = sanitizeName(r.last_name);
    if (!(cleanDomain(r.company_domain) || (r.company_name || "").trim()) || !first || !last) {
      noEmail.push({ ...r, skip_reason: "insufficient_data" });
    } else if (!validPersonName(first, last)) {
      noEmail.push({ ...r, skip_reason: "invalid_name" });
    } else {
      // API calls use the sanitized names; the row keeps its originals.
      lookup.push({ ...r, _lm_first: first, _lm_last: last });
    }
  }

  const attempts = opts.limit != null ? lookup.slice(0, opts.limit) : lookup;
  const skippedByLimit = lookup.length - attempts.length;

  const invalidNames = noEmail.filter((r) => r.skip_reason === "invalid_name").length;
  console.error(`[LM] ${rows.length} rows: ${passthrough.length} already have email, ${lookup.length} need lookup, ${noEmail.length} skipped (${noEmail.length - invalidNames} insufficient data, ${invalidNames} invalid name)${skippedByLimit ? `, ${skippedByLimit} beyond --limit` : ""}.`);
  console.error(`[LM] LeadMagic credits: ${await getCredits()} (1 credit per FOUND email, 0 per miss).`);

  if (opts.dryRun) {
    console.error(`[LM] Dry run — nothing spent, nothing written. Worst-case cost: ${attempts.length} credits.`);
    return;
  }

  // Resume journal.
  const journal: Journal = opts.resume ? loadJournal(opts.progressFile) : new Map();
  if (opts.resume && journal.size) {
    console.error(`[LM] Resume: ${journal.size} lookups already journaled in ${opts.progressFile}.`);
  } else if (!opts.resume && fs.existsSync(opts.progressFile)) {
    fs.unlinkSync(opts.progressFile); // fresh run — stale journal would poison a later --resume
  }
  fs.mkdirSync(path.dirname(opts.progressFile), { recursive: true });

  const found: Record<string, string>[] = [];
  const errors: Record<string, string>[] = [];
  let apiCalls = 0;
  let fatal: FatalApiError | null = null;
  let done = 0;

  await pool(attempts, opts.concurrency, async (r) => {
    if (fatal) return;
    const key = rowKey(r);
    const prior = journal.get(key);
    let outcome: { outcome: string; email?: string; leadmagic_status?: string };

    if (prior && (prior.outcome === "found" || prior.outcome === "not_found" || prior.outcome === "permanent_error")) {
      outcome = prior;
    } else {
      const body: Record<string, string> = {
        first_name: (r._lm_first || r.first_name).trim(),
        last_name: (r._lm_last || r.last_name).trim(),
      };
      const domain = cleanDomain(r.company_domain);
      if (domain) body.domain = domain;
      if ((r.company_name || "").trim()) body.company_name = r.company_name.trim();
      try {
        apiCalls++;
        const data = await leadmagicPost("/v1/people/email-finder", body);
        const email = (data?.email || "").trim();
        const status = String(data?.status ?? data?.email_status ?? "").trim();
        outcome = email.includes("@")
          ? { outcome: "found", email, leadmagic_status: status }
          : { outcome: "not_found", leadmagic_status: status || (data?.message ? String(data.message).slice(0, 80) : "") };
      } catch (e) {
        if (e instanceof FatalApiError) { fatal = e; return; }
        const msg = String(e).slice(0, 200);
        // 4xx (other than auth/credits, handled above) won't succeed on retry —
        // journal as permanent so --resume doesn't burn calls on them forever.
        if (/HTTP 4\d\d/.test(msg)) {
          outcome = { outcome: "permanent_error", leadmagic_status: msg };
          fs.appendFileSync(opts.progressFile, JSON.stringify({ key, ...outcome }) + "\n");
          errors.push({ ...r, error: `${msg} (permanent — will not retry)` });
        } else {
          errors.push({ ...r, error: msg });
          return; // transient errors are NOT journaled → retried on --resume
        }
      }
      if (outcome.outcome !== "permanent_error") {
        fs.appendFileSync(opts.progressFile, JSON.stringify({ key, ...outcome }) + "\n");
      }
    }

    if (outcome.outcome === "found") {
      found.push({ ...r, email: outcome.email!, email_source: "leadmagic", leadmagic_status: outcome.leadmagic_status ?? "" });
    } else if (outcome.outcome === "permanent_error") {
      noEmail.push({ ...r, skip_reason: "permanent_error" });
    } else {
      noEmail.push({ ...r, skip_reason: outcome.leadmagic_status ? `not_found (${outcome.leadmagic_status})` : "not_found" });
    }
    done++;
    if (done % 25 === 0) console.error(`  [LM] ${done}/${attempts.length} lookups (${found.length} found)`);
  });

  if (fatal) {
    console.error(`\n[LM] ABORTED: ${(fatal as FatalApiError).message}`);
    console.error(`[LM] Progress saved — rerun the same command with --resume to continue without re-spending.`);
    process.exit(1);
  }

  // Merge: passthrough + found, dedupe by email then linkedin_url.
  const mergedHeaders = [...headers.filter((h) => h !== "leadmagic_status"), "leadmagic_status"];
  const byEmail = new Map<string, Record<string, string>>();
  const seenLinkedin = new Set<string>();
  let dupes = 0;
  // Passthrough first: on an email collision the vayne row wins (it cost nothing extra).
  for (const r of [...passthrough, ...found]) {
    const email = r.email.trim().toLowerCase();
    const li = (r.linkedin_url || "").trim().toLowerCase().replace(/\/+$/, "");
    if (byEmail.has(email) || (li && seenLinkedin.has(li))) { dupes++; continue; }
    byEmail.set(email, { leadmagic_status: "", ...r });
    if (li) seenLinkedin.add(li);
  }
  const merged = [...byEmail.values()];

  writeCsv(opts.outFound, mergedHeaders, found);
  writeCsv(opts.outNoEmail, [...headers, "skip_reason"], noEmail);
  if (errors.length) writeCsv(opts.outErrors, [...headers, "error"], errors);
  writeCsv(opts.outMerged, mergedHeaders, merged);

  // Summary.
  const hitRate = attempts.length ? ((found.length / attempts.length) * 100).toFixed(1) : "0";
  console.error("\n=== LeadMagic email finding ===");
  console.error(`  input rows            ${rows.length}`);
  console.error(`  already had email     ${passthrough.length}`);
  console.error(`  lookups attempted     ${attempts.length}${skippedByLimit ? ` (+${skippedByLimit} beyond --limit)` : ""} (${apiCalls} API calls)`);
  console.error(`  emails found          ${found.length}  (${hitRate}% hit rate)`);
  console.error(`  still no email        ${noEmail.length}  → ${opts.outNoEmail}`);
  const permanentErrors = errors.filter((r) => (r.error || "").includes("permanent")).length;
  console.error(`  row errors            ${errors.length}${errors.length ? `  → ${opts.outErrors} (${errors.length - permanentErrors} retryable with --resume, ${permanentErrors} permanent)` : ""}`);
  console.error(`  merged (deduped)      ${merged.length}  (${dupes} dupes removed)`);
  console.error(`  credits remaining     ${await getCredits()}`);
  console.error(`\nWrote ${opts.outMerged} — next step, verify EVERYTHING:`);
  console.error(`  npx tsx .claude/skills/millionverifier/scripts/bulk-verify.ts \\`);
  console.error(`    --file=${opts.outMerged} --keep=ok \\`);
  console.error(`    --out-send-ready=Lead-Lists/4-Final-Lead-Lists/${path.basename(opts.outMerged).replace(/\.csv$/i, "").replace(/_merged$/i, "")}_final.csv`);
}

main().catch((e) => { console.error(e); process.exit(1); });
