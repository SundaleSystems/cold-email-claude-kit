#!/usr/bin/env tsx
/**
 * Add leads from a CSV to an existing Instantly campaign.
 * - Maps CSV columns to Instantly fields (email, first_name, last_name, company_name, website)
 *   and puts every other column into custom_variables.
 * - Always dedupes at workspace level (skip_if_in_workspace) so previously contacted people
 *   are never re-emailed.
 * - Probes with 1 lead first so a plan "Lead limit reached" 403 is caught before a big batch.
 *
 * Usage:
 *   npx tsx account-manager/scripts/add-leads.ts --campaign=<id> --csv=<path> [--max=1000] [--map=company_name:company,title:job_title] [--dry]
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { api, ApiError, flag, hasFlag, parseCsv, REPO_ROOT, sleep } from "./_lib";

const BUILTIN: Record<string, string> = {
  email: "email", first_name: "first_name", last_name: "last_name",
  company_name: "company_name", website: "website", phone: "phone",
};
const DEFAULT_ALIASES: Record<string, string> = {
  company: "company_name", corporate_website: "website", company_domain: "website",
  job_title: "title", title: "title",
};
const DROP = new Set(["email_source", "leadmagic_status", "mv_result", "mv_free", "email_finder_mx_provider", "mx_provider", "personalization_status", "confidence", "priority"]);

export interface AddResult {
  attempted: number; uploaded: number; duplicated: number; invalid: number; skipped: number; blocklist: number;
  remaining_in_plan?: number; error?: string;
}

export function buildLeads(csvPath: string, columnMap: Record<string, string> = {}, max = Infinity) {
  const abs = csvPath.startsWith("/") ? csvPath : resolve(REPO_ROOT, csvPath);
  const { headers, rows } = parseCsv(readFileSync(abs, "utf8"));
  // columnMap: instantlyField -> csvColumn
  const reverse: Record<string, string> = {};
  for (const [field, col] of Object.entries(columnMap)) reverse[col] = field;
  const emailCol = columnMap.email ?? "email";
  if (!headers.includes(emailCol)) throw new Error(`CSV has no '${emailCol}' column: ${headers.join(",")}`);

  const seen = new Set<string>();
  const leads: any[] = [];
  for (const r of rows) {
    const email = (r[emailCol] ?? "").toLowerCase().trim();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    const lead: any = { email, custom_variables: {} as Record<string, string> };
    for (const h of headers) {
      if (h === emailCol || DROP.has(h)) continue;
      const v = r[h] ?? "";
      if (!v) continue;
      const field = reverse[h] ?? DEFAULT_ALIASES[h] ?? h;
      if (field in BUILTIN) lead[field] = v;
      else lead.custom_variables[field] = v;
    }
    // camelCase mirrors that older campaign copy in this workspace uses
    if (lead.first_name) lead.custom_variables.firstName = lead.first_name;
    if (lead.last_name) lead.custom_variables.lastName = lead.last_name;
    if (lead.company_name) lead.custom_variables.companyName = lead.company_name;
    if (lead.website && !lead.custom_variables.company_domain) lead.custom_variables.company_domain = lead.website;
    leads.push(lead);
    if (leads.length >= max) break;
  }
  return { leads, headers, total_rows: rows.length };
}

export async function addLeads(campaignId: string, leads: any[], opts: { dry?: boolean } = {}): Promise<AddResult> {
  const res: AddResult = { attempted: leads.length, uploaded: 0, duplicated: 0, invalid: 0, skipped: 0, blocklist: 0 };
  if (!leads.length || opts.dry) return res;
  const post = (batch: any[]) => api("/leads/add", {
    method: "POST",
    body: JSON.stringify({ campaign_id: campaignId, skip_if_in_workspace: true, skip_if_in_campaign: true, leads: batch }),
  });
  const absorb = (j: any) => {
    res.uploaded += j.leads_uploaded ?? 0; res.duplicated += j.duplicated_leads ?? 0;
    res.invalid += j.invalid_email_count ?? 0; res.skipped += j.skipped_count ?? 0; res.blocklist += j.in_blocklist ?? 0;
    if (typeof j.remaining_in_plan === "number") res.remaining_in_plan = j.remaining_in_plan;
  };
  try {
    absorb(await post(leads.slice(0, 1)));            // probe: catches plan-limit 403 cheaply
    for (let i = 1; i < leads.length; i += 1000) {
      absorb(await post(leads.slice(i, i + 1000)));
      await sleep(500);
    }
  } catch (e: any) {
    res.error = e instanceof ApiError ? `${e.status} ${e.body.slice(0, 200)}` : String(e);
  }
  return res;
}

async function main() {
  const campaign = flag("campaign"); const csv = flag("csv");
  if (!campaign || !csv) { console.error("Usage: --campaign=<id> --csv=<path> [--max=N] [--map=field:col,...] [--dry]"); process.exit(1); }
  const map: Record<string, string> = {};
  for (const pair of (flag("map") ?? "").split(",").filter(Boolean)) { const [f, c] = pair.split(":"); map[f] = c; }
  const { leads, headers } = buildLeads(csv, map, Number(flag("max") ?? Infinity));
  console.log(`CSV columns: ${headers.join(", ")}`);
  console.log(`Prepared ${leads.length} leads. Sample:`, JSON.stringify(leads[0], null, 1).slice(0, 600));
  const r = await addLeads(campaign, leads, { dry: hasFlag("dry") });
  console.log(JSON.stringify(r, null, 2));
  if (r.error) process.exit(2);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
