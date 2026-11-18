// Backfill location / linkedin_url / company_phone / company_industry
// onto leads already in a live Instantly campaign, sourced from the
// final lead-list CSVs. These custom variables are what the phone-hunt
// Speed-to-Call system needs to people-search a prospect the moment they
// reply interested — leads uploaded before the upload.ts allowlist fix
// don't carry them yet.
//
// Run (dry run first, always):
//   npx tsx phone-hunt/scripts/backfill-lead-vars.ts \
//     --campaign=<campaign-id> --dry-run \
//     Lead-Lists/4-Final-Lead-Lists/ecom-dtc-content-us_2026-08-20_final.csv
//   # then drop --dry-run to write.
//
// Uses INSTANTLY_API_KEY from the root .env. Self-contained, no deps.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const API = "https://api.instantly.ai";
const FIELDS = ["location", "linkedin_url", "company_phone", "company_industry"] as const;

// ---------- root .env loader (zero-dep) ----------
function loadEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* .env optional if the var is already exported */ }
}
loadEnv();

const API_KEY = process.env.INSTANTLY_API_KEY;
if (!API_KEY) {
  console.error("Missing env: INSTANTLY_API_KEY (root .env)");
  process.exit(1);
}

// ---------- args ----------
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const campaign = argv.find((a) => a.startsWith("--campaign="))?.split("=")[1];
const csvPaths = argv.filter((a) => !a.startsWith("--"));
if (!campaign) {
  console.error("Missing --campaign=<id>");
  process.exit(1);
}
if (csvPaths.length === 0) {
  console.error("Pass at least one final-list CSV path.");
  process.exit(1);
}

// ---------- minimal CSV parser (handles quoted fields + commas) ----------
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (field !== "" || row.length) { row.push(field); rows.push(row); row = []; field = ""; }
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// ---------- build email -> vars index from the CSVs ----------
const wanted = new Map<string, Record<string, string>>();
for (const p of csvPaths) {
  const rows = parseCsv(readFileSync(resolve(p), "utf8"));
  for (const r of rows) {
    const email = (r.email ?? "").toLowerCase();
    if (!email) continue;
    const vars: Record<string, string> = {};
    for (const f of FIELDS) if (r[f]) vars[f] = r[f];
    if (Object.keys(vars).length) wanted.set(email, { ...wanted.get(email), ...vars });
  }
}
console.log(`Indexed ${wanted.size} emails with backfillable vars from ${csvPaths.length} CSV(s).`);

// ---------- instantly client with 429-aware retry ----------
async function api(path: string, init: RequestInit = {}, attempts = 5): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (res.ok) return res.status === 204 ? null : res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`instantly ${init.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- walk the campaign, patch matches ----------
async function main() {
  let scanned = 0, matched = 0, patched = 0, skippedNoChange = 0;
  let cursor: string | undefined;

  while (true) {
    const page = await api(`/api/v2/leads/list`, {
      method: "POST",
      body: JSON.stringify({ campaign, limit: 100, ...(cursor ? { starting_after: cursor } : {}) }),
    });
    const items: any[] = page.items ?? [];
    if (items.length === 0) break;

    for (const lead of items) {
      scanned++;
      const email = (lead.email ?? "").toLowerCase();
      const vars = wanted.get(email);
      if (!vars) continue;
      matched++;

      // Merge — never clobber existing custom_variables (situation_line etc.).
      const existing: Record<string, unknown> = lead.custom_variables ?? {};
      const merged = { ...existing };
      let changed = false;
      for (const [k, v] of Object.entries(vars)) {
        if (existing[k] !== v) { merged[k] = v; changed = true; }
      }
      if (!changed) { skippedNoChange++; continue; }

      if (dryRun) {
        console.log(`DRY  ${email}  +{${Object.keys(vars).join(", ")}}`);
        patched++;
        continue;
      }
      await api(`/api/v2/leads/${lead.id}`, {
        method: "PATCH",
        body: JSON.stringify({ custom_variables: merged }),
      });
      patched++;
      if (patched % 25 === 0) console.log(`  …patched ${patched}`);
      await sleep(120); // gentle on the rate limit
    }

    if (!page.next_starting_after) break;
    cursor = page.next_starting_after;
  }

  console.log(
    `\n${dryRun ? "[DRY RUN] " : ""}Done. scanned=${scanned} matched=${matched} ` +
      `${dryRun ? "would-patch" : "patched"}=${patched} already-current=${skippedNoChange}`,
  );
  if (dryRun) console.log("Re-run without --dry-run to write the changes.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
