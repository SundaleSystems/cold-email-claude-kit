#!/usr/bin/env tsx
/**
 * Upload a variants.yaml + leads.csv to Instantly as a DRAFT campaign.
 *
 * ALWAYS creates in DRAFT (Instantly creates campaigns in Draft status 0).
 * No --activate flag, and /activate is never called. Review in the Instantly UI
 * and press Resume/Launch manually.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/upload.ts \
 *     --leads=path/to/leads.csv \
 *     --variants=path/to/variants.yaml
 */

import { readFileSync } from "fs";

const API = "https://api.instantly.ai";
const API_KEY = process.env.INSTANTLY_API_KEY;
if (!API_KEY) {
  console.error("Missing env: INSTANTLY_API_KEY");
  process.exit(1);
}

const LEADS_BATCH = 1000; // Instantly's /leads/add accepts up to 1000 leads per request

// Allowed CSV columns — see references/leads-csv-schema.md. Changing this requires a skill update.
const REQUIRED_COLS = ["email", "first_name", "last_name", "company_name"];
const ALLOWED_COLS = new Set([
  ...REQUIRED_COLS,
  "company_domain",
  "title",
  "linkedin_url",
  "situation_line",
  "value_line",
  "cta_line",
]);

// ---------- arg parsing ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  return {
    leads: get("--leads"),
    variants: get("--variants"),
  };
}

// ---------- CSV parsing ----------

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const cols = parseCsvLine(l);
    const r: Record<string, string> = {};
    headers.forEach((h, i) => (r[h] = (cols[i] ?? "").trim()));
    return r;
  });
  return { headers, rows };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ---------- minimal YAML parser ----------
// Supports the subset we need: nested maps, lists of maps, scalars (strings/numbers/bools), array literals [1,2,3].
// Does NOT support: anchors, tags, multi-line folded/literal strings (|, >), flow-style maps {}.
// Quoted strings ("...") are supported for values with special chars.

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

function parseYaml(text: string): YamlValue {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Strip comments (but not inside quoted strings — simple heuristic)
  const cleaned: { indent: number; content: string }[] = [];
  for (const raw of lines) {
    let line = raw;
    // strip trailing comment if not inside quotes
    let inQuote: string | null = null;
    let commentAt = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === inQuote && line[i - 1] !== "\\") inQuote = null;
      } else {
        if (c === '"' || c === "'") inQuote = c;
        else if (c === "#") { commentAt = i; break; }
      }
    }
    if (commentAt >= 0) line = line.slice(0, commentAt);
    const trimmedRight = line.replace(/\s+$/, "");
    if (!trimmedRight.trim()) continue;
    const indent = trimmedRight.search(/\S/);
    cleaned.push({ indent, content: trimmedRight.slice(indent) });
  }

  let idx = 0;
  function parseBlock(parentIndent: number): YamlValue {
    if (idx >= cleaned.length) return null;
    const firstIndent = cleaned[idx].indent;
    if (firstIndent <= parentIndent) return null;
    // detect list vs map
    if (cleaned[idx].content.startsWith("- ")) return parseList(firstIndent);
    return parseMap(firstIndent);
  }

  function parseMap(indent: number): Record<string, YamlValue> {
    const obj: Record<string, YamlValue> = {};
    while (idx < cleaned.length) {
      const line = cleaned[idx];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new Error(`Unexpected indent on line: ${line.content}`);
      }
      const content = line.content;
      const colonIdx = findColon(content);
      if (colonIdx === -1) {
        throw new Error(`Expected key: value, got: ${content}`);
      }
      const key = content.slice(0, colonIdx).trim();
      const afterColon = content.slice(colonIdx + 1).trim();
      idx++;
      if (afterColon === "") {
        // nested block
        obj[key] = parseBlock(indent);
      } else {
        obj[key] = parseScalar(afterColon);
      }
    }
    return obj;
  }

  function parseList(indent: number): YamlValue[] {
    const arr: YamlValue[] = [];
    while (idx < cleaned.length) {
      const line = cleaned[idx];
      if (line.indent < indent) break;
      if (line.indent > indent || !line.content.startsWith("- ")) break;
      const afterDash = line.content.slice(2);
      idx++;
      if (afterDash.trim() === "") {
        // "- " alone → nested block follows
        arr.push(parseBlock(indent));
        continue;
      }
      // Check if it's a key: value on the same line as -
      const colonIdx = findColon(afterDash);
      if (colonIdx !== -1 && !afterDash.trim().startsWith('"') && !afterDash.trim().startsWith("'")) {
        // inline map starting with `- key: value`
        // Treat this line's key:value as the first entry in a map, then keep parsing subsequent lines at indent+2.
        const key = afterDash.slice(0, colonIdx).trim();
        const afterKey = afterDash.slice(colonIdx + 1).trim();
        const obj: Record<string, YamlValue> = {};
        if (afterKey === "") {
          obj[key] = parseBlock(indent + 2);
        } else {
          obj[key] = parseScalar(afterKey);
        }
        // continue parsing more map keys at indent + 2
        while (idx < cleaned.length) {
          const nl = cleaned[idx];
          if (nl.indent <= indent) break;
          if (nl.content.startsWith("- ")) break;
          const ci = findColon(nl.content);
          if (ci === -1) break;
          const k2 = nl.content.slice(0, ci).trim();
          const v2 = nl.content.slice(ci + 1).trim();
          idx++;
          if (v2 === "") obj[k2] = parseBlock(nl.indent);
          else obj[k2] = parseScalar(v2);
        }
        arr.push(obj);
      } else {
        arr.push(parseScalar(afterDash));
      }
    }
    return arr;
  }

  return parseBlock(-1);
}

function findColon(s: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === inQuote && s[i - 1] !== "\\") inQuote = null;
    } else {
      if (c === '"' || c === "'") inQuote = c;
      else if (c === ":") return i;
    }
  }
  return -1;
}

function parseScalar(s: string): YamlValue {
  const t = s.trim();
  if (!t) return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((x) => parseScalar(x.trim()));
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  return t;
}

// ---------- Instantly API helpers ----------

async function inFetch(path: string, init: RequestInit = {}): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (resp.status === 429 || resp.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`${init.method ?? "GET"} ${path} → ${resp.status}: ${t.slice(0, 300)}`);
    }
    return resp.json();
  }
  throw new Error(`Exhausted retries for ${init.method ?? "GET"} ${path}`);
}

async function inPost(path: string, body: any): Promise<any> {
  return inFetch(path, { method: "POST", body: JSON.stringify(body) });
}

async function inGet(path: string): Promise<any> {
  return inFetch(path);
}

// Paginate any Instantly list endpoint ({ items, next_starting_after })
async function listAll(path: string): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  const out: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await inGet(`${path}${sep}limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
    const items = page.items ?? [];
    out.push(...items);
    if (!page.next_starting_after || !items.length) break;
    cursor = page.next_starting_after;
  }
  return out;
}

// ---------- validation ----------

function validateVariants(v: any): void {
  if (!v || typeof v !== "object") throw new Error("variants.yaml must be a map at the top level");
  if (!v.name) throw new Error("variants.yaml: `name` is required");
  if (!v.schedule) throw new Error("variants.yaml: `schedule` is required");
  if (!v.inbox_selection?.tag) throw new Error("variants.yaml: `inbox_selection.tag` is required");
  if (!Number.isFinite(v.inbox_selection?.count)) throw new Error("variants.yaml: `inbox_selection.count` must be a number");
  if (!Array.isArray(v.sequences) || !v.sequences.length) throw new Error("variants.yaml: `sequences` must be a non-empty array");
  for (const seq of v.sequences) {
    if (!Number.isFinite(seq.step)) throw new Error("sequences[].step must be a number");
    if (!Number.isFinite(seq.delay_days)) throw new Error("sequences[].delay_days must be a number");
    if (!Array.isArray(seq.variants) || !seq.variants.length) throw new Error("sequences[].variants must be a non-empty array");
    for (const variant of seq.variants) {
      if (!variant.label) throw new Error("sequences[].variants[].label required");
      if (typeof variant.subject !== "string") throw new Error("sequences[].variants[].subject must be a string (empty string OK for threaded follow-ups)");
      if (typeof variant.body !== "string" || !variant.body) throw new Error("sequences[].variants[].body is required and non-empty");
    }
  }
}

function validateCsvSchema(headers: string[]): void {
  const missing = REQUIRED_COLS.filter((c) => !headers.includes(c));
  if (missing.length) throw new Error(`leads.csv missing required columns: ${missing.join(", ")}`);
  const extras = headers.filter((h) => !ALLOWED_COLS.has(h));
  if (extras.length) {
    throw new Error(
      `leads.csv has unallowed columns: ${extras.join(", ")}.\n` +
      `To add a new column, update references/leads-csv-schema.md and the ALLOWED_COLS set in this script.`
    );
  }
}

// ---------- payload builders ----------

// variants.yaml `days` uses 1=Mon ... 7=Sun (kept for compatibility with existing files).
// Instantly's `days` object uses keys "0"=Sunday ... "6"=Saturday.
// Conversion: yaml day d (1-7) → Instantly key String(d % 7)  (7=Sun → "0", 1=Mon → "1", ..., 6=Sat → "6").
function buildDays(yamlDays: number[]): Record<string, boolean> {
  const days: Record<string, boolean> = {};
  for (let k = 0; k <= 6; k++) days[String(k)] = false;
  for (const d of yamlDays) days[String(d % 7)] = true;
  return days;
}

// Delay semantics conversion:
// - variants.yaml `delay_days` (legacy convention, kept for compatibility) = days to wait BEFORE this step sends.
// - Instantly's step `delay` = days to wait AFTER this step before the NEXT one sends.
// So Instantly step N's delay = yaml step N+1's delay_days. The last step has no next
// email, so its delay is set to 1 (value is required but never used).
function buildSteps(sequences: any[]): any[] {
  const ordered = [...sequences].sort((a, b) => a.step - b.step);
  return ordered.map((seq, i) => ({
    type: "email",
    delay: i + 1 < ordered.length ? ordered[i + 1].delay_days : 1,
    // Variant labels A/B/C map to array order — Instantly reports variant 0=A, 1=B, 2=C.
    // Empty subject "" on a follow-up step = thread as a reply (same convention as the yaml).
    variants: seq.variants.map((va: any) => ({
      subject: (va.subject || "").replace(/—/g, " - ").replace(/–/g, " - "),
      body: va.body,
    })),
  }));
}

// ---------- main ----------

async function main() {
  const args = parseArgs();
  if (!args.leads || !args.variants) {
    console.error("Usage: --leads=<path> --variants=<path>");
    process.exit(1);
  }

  // 1. Load + validate leads
  console.error(`Loading leads from ${args.leads}...`);
  const csvText = readFileSync(args.leads, "utf8");
  const { headers, rows: leads } = parseCsv(csvText);
  validateCsvSchema(headers);
  console.error(`  ${leads.length} leads, columns: ${headers.join(", ")}`);

  // 2. Load + validate variants
  console.error(`Loading variants from ${args.variants}...`);
  const variantsYaml = readFileSync(args.variants, "utf8");
  const v = parseYaml(variantsYaml) as any;
  validateVariants(v);
  const variantCount = v.sequences.reduce((s: number, seq: any) => s + seq.variants.length, 0);
  console.error(`  ${v.sequences.length} sequences, ${variantCount} total variants`);

  // 3. Resolve the inbox tag (exact label match, case-insensitive)
  const tagLabel = String(v.inbox_selection.tag);
  const tagPage = await inGet(`/api/v2/custom-tags?search=${encodeURIComponent(tagLabel)}`);
  const tags = tagPage.items ?? [];
  const tag = tags.find((t: any) => (t.label ?? "").toLowerCase() === tagLabel.toLowerCase());
  if (!tag) {
    const available = tags.map((t: any) => t.label).join(", ") || "(none matched search)";
    throw new Error(
      `Tag "${tagLabel}" not found in Instantly. Labels matching search: ${available}. ` +
      `Run /instantly-inbox-manager to tag inboxes first.`
    );
  }
  console.error(`  ✓ Tag "${tag.label}" (${tag.id})`);

  // 4. Candidate accounts: tagged + Active + fully set up
  const tagged = await listAll(`/api/v2/accounts?tag_ids=${encodeURIComponent(tag.id)}`);
  const candidates = tagged.filter((a: any) => a.status === 1 && a.setup_pending !== true);
  if (!candidates.length) {
    throw new Error(`No healthy inboxes found with tag=${tagLabel}. Run /instantly-inbox-manager to tag inboxes first.`);
  }
  console.error(`  ${candidates.length} healthy tagged accounts found`);

  // 5. LRU-select inboxes: least emails sent over the last 7 days go first
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const emailsParam = candidates.map((a: any) => `&emails=${encodeURIComponent(a.email)}`).join("");
  const dailyRows = await inGet(
    `/api/v2/accounts/analytics/daily?start_date=${fmt(start)}&end_date=${fmt(end)}${emailsParam}`
  );
  const sentByAccount: Record<string, number> = {};
  for (const row of Array.isArray(dailyRows) ? dailyRows : []) {
    sentByAccount[row.email_account] = (sentByAccount[row.email_account] ?? 0) + (row.sent ?? 0);
  }
  candidates.sort((a: any, b: any) => (sentByAccount[a.email] ?? 0) - (sentByAccount[b.email] ?? 0));
  const selected = candidates.slice(0, v.inbox_selection.count);
  if (selected.length < v.inbox_selection.count) {
    console.error(`  ⚠ Only ${selected.length} inboxes matched (requested ${v.inbox_selection.count}). Proceeding with what's available.`);
  }
  const emailList = selected.map((a: any) => a.email);
  console.error(`  ✓ ${emailList.length} inboxes selected (tag=${tagLabel}, LRU by 7-day sent volume)`);

  // 6. Create campaign — ONE call carries name, accounts, settings, schedule, and sequences.
  //    Instantly creates campaigns in Draft (status 0); nothing sends until you press Resume/Launch.
  console.error(`Creating Instantly campaign "${v.name}"...`);
  const created = await inPost("/api/v2/campaigns", {
    name: v.name,
    email_list: emailList,
    daily_limit: v.schedule.max_leads_per_day,
    stop_on_reply: true,
    open_tracking: false,
    link_tracking: false,
    email_gap: v.schedule.min_time_btw_emails,
    campaign_schedule: {
      schedules: [
        {
          name: "Schedule",
          timing: { from: v.schedule.start_hour, to: v.schedule.end_hour },
          days: buildDays(v.schedule.days),
          timezone: v.schedule.timezone,
        },
      ],
    },
    sequences: [{ steps: buildSteps(v.sequences) }],
  });
  const campaignId = created.id;
  if (!campaignId) throw new Error(`Campaign create failed: ${JSON.stringify(created)}`);
  console.error(`  ✓ Campaign ${campaignId} (${v.sequences.length} steps, ${emailList.length} inboxes, ${v.schedule.timezone} ${v.schedule.start_hour}-${v.schedule.end_hour})`);

  // 7. Upload leads in batches of 1000
  let uploaded = 0;
  for (let i = 0; i < leads.length; i += LEADS_BATCH) {
    const batch = leads.slice(i, i + LEADS_BATCH).map((l) => {
      const custom_variables: Record<string, string> = {};
      for (const h of headers) {
        if (!REQUIRED_COLS.includes(h) && l[h]) custom_variables[h] = l[h];
      }
      return {
        email: l.email,
        first_name: l.first_name || "",
        last_name: l.last_name || "",
        company_name: l.company_name || "",
        custom_variables,
      };
    });
    try {
      const res = await inPost("/api/v2/leads/add", {
        campaign_id: campaignId,
        skip_if_in_campaign: true,
        skip_if_in_workspace: true, // never re-email anyone already in any campaign/list (2026-10-20)
        leads: batch,
      });
      uploaded += res.leads_uploaded ?? 0;
      console.error(
        `  batch ${Math.floor(i / LEADS_BATCH) + 1}: ${res.leads_uploaded ?? 0} uploaded, ` +
        `${res.duplicated_leads ?? 0} duplicates, ${res.invalid_email_count ?? 0} invalid emails`
      );
    } catch (err: any) {
      console.error(`  ⚠ batch ${i}-${i + LEADS_BATCH} failed: ${err.message?.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`  ✓ ${uploaded}/${leads.length} leads uploaded`);

  // 8. DRAFT only. Do not activate — this script never calls /activate.
  console.log(``);
  console.log(`✓ Campaign ${campaignId} created in DRAFT`);
  console.log(``);
  console.log(`Review + Launch:`);
  console.log(`  → https://app.instantly.ai/app/campaigns/${campaignId}`);
  console.log(``);
  console.log(`This script does NOT auto-activate. Review the campaign in the Instantly UI and press Resume/Launch when satisfied.`);
}

main().catch((e) => {
  console.error("\nERROR:", e.message);
  process.exit(1);
});
