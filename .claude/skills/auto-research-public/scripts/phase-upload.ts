#!/usr/bin/env tsx
/**
 * Phase 7: Instantly campaign creation + upload.
 *
 * Self-contained version of the GEX v2 campaign-launcher, with:
 * - Inbox selection via Instantly custom tags (no Supabase)
 * - Local JSON state (no auto_research_inbox_assignments table)
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/phase-upload.ts \
 *     --leads-file=/tmp/auto/personalized.json \
 *     --variants-file=/tmp/auto/variants.json \
 *     --domain=target.com \
 *     --inboxes-tag=active \
 *     --inbox-count=10 \
 *     --activate
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const API_BASE = "https://api.instantly.ai";
const API_KEY = process.env.INSTANTLY_API_KEY;
if (!API_KEY) {
  console.error("Missing env: INSTANTLY_API_KEY");
  process.exit(1);
}
const LEADS_BATCH = 1000; // POST /api/v2/leads/add caps at 1000 leads per request

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  return {
    leadsFile: get("--leads-file"),
    variantsFile: get("--variants-file"),
    domain: get("--domain"),
    inboxTag: get("--inboxes-tag") ?? "active",
    inboxCount: Number(get("--inbox-count") ?? 10),
    experimentLog: get("--experiment-log"),
    activate: args.includes("--activate"),
  };
}

async function instantlyFetch(path: string, init: RequestInit = {}, attempts = 4): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${await res.text().catch(() => "")}`);
  }
}

// Paginate any Instantly list endpoint ({ items, next_starting_after })
async function listAll(path: string): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  const out: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await instantlyFetch(
      `${path}${sep}limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`
    );
    const items = page.items ?? [];
    out.push(...items);
    if (!page.next_starting_after || items.length === 0) break;
    cursor = page.next_starting_after;
  }
  return out;
}

async function selectInboxesByTag(tag: string, count: number): Promise<string[]> {
  // 1. Resolve tag label → tag id
  const tags = await listAll(`/api/v2/custom-tags?search=${encodeURIComponent(tag)}`);
  const tagObj = tags.find((t: any) => (t.label ?? "").trim().toLowerCase() === tag.toLowerCase());
  if (!tagObj) throw new Error(`No Instantly custom tag with label "${tag}"`);

  // 2. All accounts carrying that tag, healthy only (status 1 = Active, setup complete)
  const accounts = await listAll(`/api/v2/accounts?tag_ids=${encodeURIComponent(tagObj.id)}`);
  const healthy = accounts.filter((a: any) => a.status === 1 && !a.setup_pending);
  if (!healthy.length) return [];

  // 3. LRU: sum each account's sends over the last 7 days, pick the least-used first
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const daily = await instantlyFetch(`/api/v2/accounts/analytics/daily?start_date=${start}&end_date=${end}`);
  const sentByEmail: Record<string, number> = {};
  for (const row of Array.isArray(daily) ? daily : []) {
    sentByEmail[row.email_account] = (sentByEmail[row.email_account] ?? 0) + (row.sent ?? 0);
  }
  healthy.sort((a: any, b: any) => (sentByEmail[a.email] ?? 0) - (sentByEmail[b.email] ?? 0));
  return healthy.slice(0, count).map((a: any) => a.email);
}

function buildBody(variantLabel: string, campaignId: string, bodyTemplate?: string): string {
  const v = variantLabel.toLowerCase();
  if (bodyTemplate) {
    // Replace placeholders with campaign-ID-scoped variants
    return bodyTemplate
      .replace(/\{\{situation_line\}\}/g, `{{situation_line_${v}_${campaignId}}}`)
      .replace(/\{\{value_line\}\}/g, `{{value_line_${v}_${campaignId}}}`)
      .replace(/\{\{cta_line\}\}/g, `{{cta_line_${v}_${campaignId}}}`);
  }
  // No signature placeholder: Instantly appends each sending account's signature automatically.
  return `Hi {{first_name}},<br><br>{{situation_line_${v}_${campaignId}}}<br><br>{{value_line_${v}_${campaignId}}}<div><br></div>{{cta_line_${v}_${campaignId}}}<br><br>P.S. If this isn't relevant, just let me know and I won't reach out again.`;
}

async function main() {
  const args = parseArgs();
  if (!args.leadsFile || !args.variantsFile || !args.domain) {
    console.error(
      "Usage: --leads-file=... --variants-file=... --domain=... [--inboxes-tag=active] [--inbox-count=10] [--activate]"
    );
    process.exit(1);
  }

  const leads: any[] = JSON.parse(readFileSync(args.leadsFile, "utf8"));
  const variants: any[] = JSON.parse(readFileSync(args.variantsFile, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const campaignName = `[AUTO] ${today} ${args.domain}`;

  console.error(`\n[Launch] Creating campaign: ${campaignName}`);
  console.error(`  Leads: ${leads.length} | Variants: ${variants.length}`);

  // 1. Select inboxes tagged "active" (LRU by 7-day send volume)
  const inboxEmails = await selectInboxesByTag(args.inboxTag, args.inboxCount);
  if (!inboxEmails.length) throw new Error(`No healthy inboxes matching tag=${args.inboxTag}`);
  console.error(`  Selected ${inboxEmails.length} inboxes`);

  // 2. Create campaign WITHOUT sequences.
  //    The custom variable names are campaign-ID-scoped ({{situation_line_a_<id>}}...),
  //    but the id doesn't exist until Instantly creates the campaign. So: create first
  //    (sequences is optional), read the id, then PATCH the sequences in step 3.
  //    Everything else (accounts, schedule, settings) goes in this single create call.
  const campaign = await instantlyFetch("/api/v2/campaigns", {
    method: "POST",
    body: JSON.stringify({
      name: campaignName,
      email_list: inboxEmails,
      campaign_schedule: {
        schedules: [
          {
            name: "Weekdays",
            timing: { from: "08:00", to: "17:00" },
            // Instantly days keys: "0"=Sunday ... "6"=Saturday (Mon-Fri here)
            days: { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false },
            timezone: "America/New_York",
          },
        ],
      },
      daily_limit: 1000,
      daily_max_leads: 1000,
      email_gap: 8, // minutes between sends
      stop_on_reply: true,
      open_tracking: false,
      link_tracking: false,
    }),
  });
  const campaignId: string = campaign.id;
  console.error(`  Campaign created: ${campaignId}`);

  // 3. PATCH the A/B/C sequence, now that we have the id for the scoped variable names
  await instantlyFetch(`/api/v2/campaigns/${campaignId}`, {
    method: "PATCH",
    body: JSON.stringify({
      sequences: [
        {
          steps: [
            {
              type: "email",
              delay: 0,
              variants: variants.map((v: any) => ({
                subject: (v.subject || "").replace(/—/g, " - ").replace(/–/g, " - "),
                body: buildBody(v.variant, campaignId, v.body_template),
              })),
            },
          ],
        },
      ],
    }),
  });
  console.error(`  Saved ${variants.length} variants`);

  // 4. Upload leads in batches of 1000
  let uploaded = 0;
  for (let i = 0; i < leads.length; i += LEADS_BATCH) {
    const batch = leads.slice(i, i + LEADS_BATCH).map((l: any) => ({
      email: l.email,
      first_name: l.first_name || "",
      last_name: l.last_name || "",
      company_name: l.company_name || "",
      custom_variables: {
        Title: l.job_title || "",
        LinkedIn: l.linkedin_url || "",
        Company_Domain: l.company_domain || "",
        Company_Industry: l.company_industry || "",
        [`situation_line_a_${campaignId}`]: l.situation_line_a || "",
        [`value_line_a_${campaignId}`]: l.value_line_a || "",
        [`cta_line_a_${campaignId}`]: l.cta_line_a || "",
        [`situation_line_b_${campaignId}`]: l.situation_line_b || "",
        [`value_line_b_${campaignId}`]: l.value_line_b || "",
        [`cta_line_b_${campaignId}`]: l.cta_line_b || "",
        [`situation_line_c_${campaignId}`]: l.situation_line_c || "",
        [`value_line_c_${campaignId}`]: l.value_line_c || "",
        [`cta_line_c_${campaignId}`]: l.cta_line_c || "",
      },
    }));
    try {
      const res = await instantlyFetch("/api/v2/leads/add", {
        method: "POST",
        body: JSON.stringify({ campaign_id: campaignId, skip_if_in_campaign: true, leads: batch }),
      });
      uploaded += res.leads_uploaded ?? batch.length;
      if (res.invalid_email_count || res.duplicated_leads) {
        console.error(
          `    batch ${Math.floor(i / LEADS_BATCH) + 1}: ${res.invalid_email_count ?? 0} invalid, ${res.duplicated_leads ?? 0} duplicates skipped`
        );
      }
    } catch (err: any) {
      console.error(`    batch ${Math.floor(i / LEADS_BATCH) + 1}: ${err.message.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`  Uploaded ${uploaded} leads`);

  // 5. Activate
  if (args.activate) {
    await instantlyFetch(`/api/v2/campaigns/${campaignId}/activate`, { method: "POST" });
    console.error(`  Campaign ${campaignId} is LIVE`);
  } else {
    console.error(`  Campaign ${campaignId} created in DRAFT`);
  }
  console.error(`  https://app.instantly.ai/app/campaigns/${campaignId}`);

  // 6. Save local experiment log
  const result = {
    instantly_campaign_id: campaignId,
    campaign_name: campaignName,
    domain: args.domain,
    date: today,
    inboxes_assigned: inboxEmails,
    variants,
    lead_count_uploaded: uploaded,
    launched_at: new Date().toISOString(),
    status: args.activate ? "launched" : "draft",
  };
  if (args.experimentLog) {
    mkdirSync(dirname(args.experimentLog), { recursive: true });
    writeFileSync(args.experimentLog, JSON.stringify(result, null, 2));
    console.error(`  Wrote experiment log to ${args.experimentLog}`);
  }

  console.log(JSON.stringify({ campaignId, inboxCount: inboxEmails.length, leadsUploaded: uploaded }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
