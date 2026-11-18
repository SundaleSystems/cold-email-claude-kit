#!/usr/bin/env tsx
/**
 * Bulk-verify a leads CSV with MillionVerifier's Bulk API.
 *
 * Pipeline: read CSV → preflight credits → upload → poll → download → merge.
 *
 * Usage:
 *   npx tsx skills/millionverifier/scripts/bulk-verify.ts --file=leads.csv
 *   npx tsx skills/millionverifier/scripts/bulk-verify.ts --file=leads.csv --keep=ok,catch_all
 *   npx tsx skills/millionverifier/scripts/bulk-verify.ts --file=leads.csv --resume=940
 *
 * Flags:
 *   --file=leads.csv       input CSV (required)
 *   --email-col=email      email column name, case-insensitive (default: email)
 *   --keep=ok              statuses kept in the send-ready output, comma-separated
 *                          (ok | catch_all | unknown | invalid | disposable; default: ok)
 *   --timeout=60           max minutes to wait for verification (default: 60)
 *   --stall-minutes=10     past 99% with no progress for this long, finalize the
 *                          file via /bulkapi/stop — greylisted stragglers come back
 *                          unverified (never ok). 0 disables. (default: 10)
 *   --resume=<file_id>     skip upload; poll/download an existing MV file id
 *   --delete-remote        delete the file from MillionVerifier after download
 *   --out-verified=path    default: <input>.verified.csv   (all rows + email_status)
 *   --out-send-ready=path  default: <input>.send-ready.csv (kept rows, no email_status)
 *
 * Outputs:
 *   <input>.verified.csv   — every row + email_status column (feeds /list-quality-scorecard)
 *   <input>.send-ready.csv — only --keep rows, email_status dropped (feeds /instantly-campaign-upload-public)
 *
 * Requires MILLIONVERIFIER_API_KEY (repo-root .env or exported).
 * Note: the demo key API_KEY_FOR_TEST only works on the Single API — the Bulk
 * API rejects it, so this script needs a real key.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── env (repo-root .env, no dotenv dependency) ──────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function findEnvFile(): string | null {
  // Walk up from the script dir (works from skills/ and .claude/skills/), then try CWD.
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
const API_KEY = env.MILLIONVERIFIER_API_KEY;
if (!API_KEY) {
  console.error("Missing env: MILLIONVERIFIER_API_KEY. Add it to .env (see .env.example).");
  process.exit(1);
}
if (API_KEY === "API_KEY_FOR_TEST") {
  console.error("The demo key API_KEY_FOR_TEST only works on the Single API — the Bulk API rejects it with invalid_api_key. Use a real key (https://app.millionverifier.com/api), or test single emails with single-verify.ts.");
  process.exit(1);
}

// Overridable for testing against a mock server.
const SINGLE_BASE = env.MV_SINGLE_BASE || "https://api.millionverifier.com";
const BULK_BASE = env.MV_BULK_BASE || "https://bulkapi.millionverifier.com";

// ── args ────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const file = get("--file");
  if (!file) {
    console.error("Usage: --file=leads.csv [--email-col=email] [--keep=ok] [--timeout=60] [--resume=<file_id>] [--delete-remote]");
    process.exit(1);
  }
  const base = file.replace(/\.csv$/i, "");
  return {
    file,
    emailCol: (get("--email-col") ?? "email").toLowerCase(),
    keep: (get("--keep") ?? "ok").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
    timeoutMin: Number(get("--timeout") ?? 60),
    stallMin: Number(get("--stall-minutes") ?? 10),
    resume: get("--resume"),
    deleteRemote: args.includes("--delete-remote"),
    outVerified: get("--out-verified") ?? `${base}.verified.csv`,
    outSendReady: get("--out-send-ready") ?? `${base}.send-ready.csv`,
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
  const headers = parseCsvLine(lines[0]);
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
  const out = [headers.join(",")];
  for (const r of rows) out.push(headers.map((h) => escapeCsv(r[h])).join(","));
  fs.writeFileSync(filepath, out.join("\n") + "\n");
}

// ── HTTP with 429/5xx backoff ───────────────────────────────────────
async function fetchWithRetry(url: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, init).catch((e) => {
      if (attempt < attempts) return null;
      throw e;
    });
    if (resp && resp.ok) return resp;
    if (resp && resp.status < 500 && resp.status !== 429) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    if (attempt >= attempts) {
      throw new Error(`HTTP ${resp?.status ?? "network error"} after ${attempts + 1} attempts`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<any> {
  const resp = await fetchWithRetry(url, init);
  return resp.json();
}

const normalizeStatus = (s: string) => s.trim().toLowerCase().replace(/[ -]/g, "_");

// ── pipeline steps ──────────────────────────────────────────────────
async function preflight(uniqueEmails: number): Promise<void> {
  const info = await fetchJson(`${SINGLE_BASE}/api/v3/credits?api=${API_KEY}`);
  const credits = info.credits ?? 0;
  console.error(`[MV] Credits available: ${credits} (plan: ${info.plan ?? "?"})`);
  if (credits < uniqueEmails) {
    console.error(`[MV] Not enough credits: need ${uniqueEmails}, have ${credits}. Top up at https://app.millionverifier.com/`);
    process.exit(1);
  }
}

async function upload(emails: string[], inputFile: string): Promise<{ fileId: string; estimatedSec: number }> {
  const fd = new FormData();
  const name = `${path.basename(inputFile).replace(/\.csv$/i, "")}-${new Date().toISOString().slice(0, 10)}.txt`;
  fd.append("file_contents", new Blob([emails.join("\n")], { type: "text/plain" }), name);
  const data = await fetchJson(`${BULK_BASE}/bulkapi/v2/upload?key=${API_KEY}`, { method: "POST", body: fd });
  if (data.error === "insufficient_credits") {
    console.error(`[MV] Insufficient credits: file has ${data.unique_emails} unique emails, account has ${data.credits} credits.`);
    process.exit(1);
  }
  if (data.error) throw new Error(`Upload failed: ${data.error}`);
  console.error(`[MV] Uploaded as file_id=${data.file_id} (${data.unique_emails} unique emails, ~${data.estimated_time_sec ?? "?"}s estimated). Resume with --resume=${data.file_id} if interrupted.`);
  return { fileId: String(data.file_id), estimatedSec: Number(data.estimated_time_sec ?? 0) };
}

async function poll(fileId: string, timeoutMin: number, stallMin: number): Promise<any> {
  const start = Date.now();
  let lastVerified = -1;
  let lastProgressAt = Date.now();
  let stoppedByUs = false;
  while (Date.now() - start < timeoutMin * 60 * 1000) {
    const info = await fetchJson(`${BULK_BASE}/bulkapi/v2/fileinfo?key=${API_KEY}&file_id=${fileId}`);
    if (info.error && info.status === undefined) throw new Error(`fileinfo failed: ${info.error}`);
    if (info.status === "finished") return info;
    if (info.status === "error" || info.status === "canceled") {
      // A file we deliberately stopped reports canceled but its results are
      // downloadable a few seconds later — that's success, not failure.
      if (stoppedByUs) return info;
      throw new Error(`Verification ${info.status}: ${info.error || "no detail"}`);
    }
    const verified = Number(info.verified ?? 0);
    if (verified !== lastVerified) { lastVerified = verified; lastProgressAt = Date.now(); }
    const pct = Number(info.percent ?? 0);
    // Greylisting can hold the last 1-2 emails in reverify for 20+ minutes.
    // Past 99% with no progress for stallMin, finalize: the stragglers come
    // back unverified (never `ok`), so an ok-only list is unaffected.
    if (!stoppedByUs && stallMin > 0 && pct >= 99 && Date.now() - lastProgressAt > stallMin * 60 * 1000) {
      const remaining = Number(info.unverified ?? 0) || "a few";
      console.error(`[MV] Stalled at ${pct}% for ${stallMin}+ min (${remaining} greylisted emails in reverify) — finalizing via /bulkapi/stop. Disable with --stall-minutes=0.`);
      await fetchJson(`${BULK_BASE}/bulkapi/stop?key=${API_KEY}&file_id=${fileId}`).catch((e) =>
        console.error(`[MV] stop call failed (${String(e).slice(0, 120)}) — continuing to poll normally.`),
      );
      stoppedByUs = true;
    }
    console.error(`[MV] ${info.status} ${info.percent ?? 0}% — ok:${info.ok ?? 0} catch_all:${info.catch_all ?? 0} invalid:${info.invalid ?? 0} unknown:${info.unknown ?? 0} disposable:${info.disposable ?? 0}`);
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error(`Timed out after ${timeoutMin} minutes. The file is still processing on MV — rerun later with --resume=${fileId}`);
}

async function download(fileId: string): Promise<Map<string, string>> {
  const resp = await fetchWithRetry(`${BULK_BASE}/bulkapi/v2/download?key=${API_KEY}&file_id=${fileId}&filter=all`);
  const text = await resp.text();
  if (text.trim().startsWith("{")) {
    const data = JSON.parse(text);
    throw new Error(`Download failed: ${data.error ?? text.slice(0, 200)}`);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("Download returned an empty report");
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  let emailIdx = header.findIndex((h) => h.includes("email"));
  let resultIdx = header.findIndex((h) => h.includes("result") || h === "status");
  let dataLines = lines.slice(1);
  if (emailIdx === -1) {
    // no header row — assume col 0 = email, col 1 = result
    emailIdx = 0;
    resultIdx = 1;
    dataLines = lines;
  }
  const map = new Map<string, string>();
  for (const line of dataLines) {
    const cols = parseCsvLine(line);
    const email = (cols[emailIdx] ?? "").trim().toLowerCase();
    if (!email.includes("@")) continue;
    map.set(email, normalizeStatus(cols[resultIdx] ?? "unknown"));
  }
  return map;
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const { headers, rows } = readCsv(opts.file);
  const emailHeader = headers.find((h) => h.trim().toLowerCase() === opts.emailCol);
  if (!emailHeader) {
    console.error(`Column "${opts.emailCol}" not found in ${opts.file}. Headers: ${headers.join(", ")}`);
    process.exit(1);
  }
  const uniqueEmails = Array.from(new Set(
    rows.map((r) => (r[emailHeader] ?? "").trim().toLowerCase()).filter((e) => e.includes("@"))
  ));
  if (uniqueEmails.length === 0) {
    console.error(`No emails found in column "${emailHeader}".`);
    process.exit(1);
  }
  console.error(`[MV] ${rows.length} rows, ${uniqueEmails.length} unique emails in "${emailHeader}".`);

  let fileId = opts.resume;
  if (!fileId) {
    await preflight(uniqueEmails.length);
    ({ fileId } = await upload(uniqueEmails, opts.file));
  } else {
    console.error(`[MV] Resuming file_id=${fileId} (skipping upload).`);
  }

  const finalInfo = await poll(fileId, opts.timeoutMin, opts.stallMin);
  const results = await download(fileId);
  console.error(`[MV] Downloaded ${results.size} results.`);

  // merge
  const counts: Record<string, number> = {};
  const verifiedRows = rows.map((r) => {
    const email = (r[emailHeader] ?? "").trim().toLowerCase();
    const status = email.includes("@") ? (results.get(email) ?? "unknown") : "no_email";
    counts[status] = (counts[status] ?? 0) + 1;
    return { ...r, email_status: status };
  });
  writeCsv(opts.outVerified, [...headers, "email_status"], verifiedRows);

  const sendReady = verifiedRows
    .filter((r) => opts.keep.includes(r.email_status))
    .map(({ email_status, ...rest }) => rest);
  writeCsv(opts.outSendReady, headers, sendReady);

  if (opts.deleteRemote) {
    const del = await fetchJson(`${BULK_BASE}/bulkapi/v2/delete?key=${API_KEY}&file_id=${fileId}`).catch((e) => ({ error: String(e) }));
    console.error(del.result === "ok" ? "[MV] Remote file deleted." : `[MV] Remote delete failed: ${del.error}`);
  }

  // summary
  const total = verifiedRows.length;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  console.error("\n=== MillionVerifier bulk results ===");
  for (const status of ["ok", "catch_all", "unknown", "invalid", "disposable", "no_email"]) {
    if (counts[status]) console.error(`  ${status.padEnd(11)} ${String(counts[status]).padStart(6)}  (${pct(counts[status])})`);
  }
  for (const [status, n] of Object.entries(counts)) {
    if (!["ok", "catch_all", "unknown", "invalid", "disposable", "no_email"].includes(status)) {
      console.error(`  ${status.padEnd(11)} ${String(n).padStart(6)}  (${pct(n)})`);
    }
  }
  if ((counts.catch_all ?? 0) / total > 0.25) {
    console.error("  ⚠ catch_all is over 25% — expect elevated bounce risk if you send to these. Consider dropping them or verifying via a waterfall.");
  }
  console.error(`  credits used: ${finalInfo.credit ?? "?"}`);
  console.error(`\nWrote ${opts.outVerified} (${total} rows + email_status — feed to /list-quality-scorecard)`);
  console.error(`Wrote ${opts.outSendReady} (${sendReady.length} rows kept [${opts.keep.join(",")}] — ready for /instantly-campaign-upload-public)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
