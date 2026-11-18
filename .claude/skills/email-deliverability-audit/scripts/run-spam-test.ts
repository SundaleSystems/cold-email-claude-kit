#!/usr/bin/env tsx
/**
 * Create + poll + pull an Instantly Inbox Placement test (spam placement).
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/run-spam-test.ts --campaign-id=<uuid> --senders=100 --out=/tmp/spam-test.json
 *   npx tsx scripts/run-spam-test.ts --tag=active --out=/tmp/spam-test.json
 *   npx tsx scripts/run-spam-test.ts --emails=a@x.com,b@y.com --all-esps --out=/tmp/spam-test.json
 *
 * Notes:
 *   - Default seed pools: Google + Microsoft ESP entries (the two pools that
 *     matter for cold email). Pass --all-esps to seed every available ESP.
 *   - When --campaign-id is given, senders come from the campaign's email_list
 *     and the test email uses the campaign's step-1 variant-A subject/body.
 *   - Takes 5-20+ minutes to complete. Polls every 30s, --timeout=25 (minutes).
 *   - Inbox Placement tests are plan-gated (workspace `plan_id_inbox_placement`).
 *     A 402/403 means your Instantly plan doesn't include them.
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const API_BASE = "https://api.instantly.ai";
const API_KEY = process.env.INSTANTLY_API_KEY;
if (!API_KEY) {
  console.error("Missing env: INSTANTLY_API_KEY");
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const arg = args.find((a) => a.startsWith(`${flag}=`));
    return arg ? arg.split("=").slice(1).join("=") : undefined;
  };
  const campaignId = get("--campaign-id");
  const tag = get("--tag");
  const emails = get("--emails")?.split(",").map((s) => s.trim()).filter(Boolean);
  const senders = Number(get("--senders") ?? 100);
  const allEsps = args.includes("--all-esps");
  const timeoutMin = Number(get("--timeout") ?? 25);
  const out = get("--out") ?? "/tmp/spam-test.json";
  const testName = get("--name") ?? `audit-${new Date().toISOString().slice(0, 10)}`;
  if (!campaignId && !tag && !emails?.length) {
    console.error("Usage: --campaign-id=<uuid> | --tag=<label> | --emails=a@x.com,b@y.com [--senders=100] [--all-esps] [--timeout=25] [--out=path]");
    process.exit(1);
  }
  return { campaignId, tag, emails, senders, allEsps, timeoutMin, out, testName };
}

async function fetchJson(path: string, init: RequestInit = {}, attempts = 4): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (resp.ok) return resp.json();
    if (resp.status === 402 || resp.status === 403) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `HTTP ${resp.status}: your Instantly plan doesn't include Inbox Placement tests ` +
        `(workspace plan_id_inbox_placement). Upgrade in Instantly → Settings → Billing. ${body.slice(0, 200)}`
      );
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < attempts) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
}

async function listAllPages(path: string): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  const all: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await fetchJson(`${path}${sep}limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
    const items = page.items ?? [];
    all.push(...items);
    if (!page.next_starting_after || !items.length) break;
    cursor = page.next_starting_after;
  }
  return all;
}

const GENERIC_SUBJECT = "Quick question about your process";
const GENERIC_BODY =
  "Hi there,\n\nI was reviewing how teams in your space handle outreach and had a quick question. " +
  "Do you have a few minutes this week to compare notes?\n\nThanks,\nDeliverability audit";

async function main() {
  const { campaignId, tag, emails, senders: maxSenders, allEsps, timeoutMin, out, testName } = parseArgs();

  // 1. Resolve sender accounts + email copy
  let senderAccounts: string[] = [];
  let emailSubject = GENERIC_SUBJECT;
  let emailBody = GENERIC_BODY;
  if (campaignId) {
    console.error(`Fetching campaign ${campaignId}...`);
    const campaign = await fetchJson(`/api/v2/campaigns/${campaignId}`);
    senderAccounts = (campaign.email_list ?? []).slice(0, maxSenders);
    if (!senderAccounts.length) throw new Error(`No email accounts on campaign ${campaignId}`);
    // Use the campaign's first step, first variant as the test copy —
    // that's the email whose placement we actually care about.
    const variant = campaign.sequences?.[0]?.steps?.[0]?.variants?.[0];
    if (variant?.body) {
      emailSubject = variant.subject || GENERIC_SUBJECT;
      emailBody = variant.body;
      console.error(`  Using step-1 variant-A copy: "${emailSubject}"`);
    } else {
      console.error("  Campaign has no readable step copy — using generic test copy");
    }
  } else if (emails?.length) {
    senderAccounts = emails.slice(0, maxSenders);
  } else if (tag) {
    console.error(`Fetching accounts tagged "${tag}"...`);
    const accounts = await listAllPages(`/api/v2/accounts?include_tags=true`);
    senderAccounts = accounts
      .filter((a: any) => (a.tags ?? []).some((t: any) => (t?.label ?? t?.name) === tag))
      .map((a: any) => a.email)
      .filter(Boolean)
      .slice(0, maxSenders);
    if (!senderAccounts.length) throw new Error(`No accounts tagged "${tag}"`);
  }
  console.error(`  Using ${senderAccounts.length} senders`);

  // 2. Pick seed ESP options (Google + Microsoft by default — the pools that matter)
  console.error("Fetching seed ESP options...");
  const espOptions = await fetchJson(`/api/v2/inbox-placement-tests/email-service-provider-options`);
  const options: any[] = Array.isArray(espOptions) ? espOptions : [];
  if (!options.length) throw new Error("No inbox placement ESP options available");
  const chosenOptions = allEsps
    ? options
    : options.filter((o) => /google|gmail|microsoft|outlook|office/i.test(o.esp ?? ""));
  if (!chosenOptions.length) throw new Error("No Google/Microsoft ESP options found — retry with --all-esps");
  console.error(`  Seeding ${chosenOptions.length}/${options.length} ESP pools: ${[...new Set(chosenOptions.map((o) => o.esp))].join(", ")}`);

  // 3. Create the inbox placement test
  console.error("Creating inbox placement test...");
  const createBody = {
    name: testName,
    description: campaignId
      ? `Deliverability audit for campaign ${campaignId}`
      : `Deliverability audit (${tag ? `tag=${tag}` : "manual sender list"})`,
    type: 1, // one-time test
    sending_method: 1, // sent from Instantly accounts
    ...(campaignId ? { campaign_id: campaignId } : {}),
    emails: senderAccounts,
    email_subject: emailSubject,
    email_body: emailBody,
    recipients_labels: chosenOptions,
    run_immediately: true,
  };
  const created = await fetchJson(`/api/v2/inbox-placement-tests`, {
    method: "POST",
    body: JSON.stringify(createBody),
  });
  const testId = created.id;
  console.error(`  Test created: id=${testId}`);

  // 4. Poll for completion. Test status: 1/2 = pending/running, 3 = complete.
  console.error(`Polling for completion (up to ${timeoutMin} min)...`);
  const start = Date.now();
  let status: number | null | undefined;
  while (Date.now() - start < timeoutMin * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 30000));
    const detail = await fetchJson(`/api/v2/inbox-placement-tests/${testId}`);
    status = detail.status;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.error(`  [${elapsed}s] status=${status}${detail.not_sending_status ? ` not_sending=${detail.not_sending_status}` : ""}`);
    if (status === 3) break;
  }
  if (status !== 3) {
    console.error(`  Timed out with status=${status} — pulling whatever results exist so far.`);
  }

  // 5. Pull reports
  console.error("Fetching reports...");
  // 5a. Placement stats: inbox / spam / category percentages
  const stats = await fetchJson(`/api/v2/inbox-placement-analytics/stats-by-test-id`, {
    method: "POST",
    body: JSON.stringify({ test_ids: [testId] }),
  }).catch((e: any) => ({ error: String(e) }));
  // 5b. Per-recipient detail: SPF/DKIM/DMARC pass per received email
  const perRecipient = await listAllPages(
    `/api/v2/inbox-placement-analytics?test_id=${encodeURIComponent(testId)}`
  ).catch((e: any) => [{ error: String(e) }]);
  // 5c. Per-domain SpamAssassin score/rules + blacklist report
  const domainReports = await listAllPages(
    `/api/v2/inbox-placement-reports?test_id=${encodeURIComponent(testId)}`
  ).catch((e: any) => [{ error: String(e) }]);
  // 5d. Deliverability insights (per sender-ESP × recipient-ESP breakdown)
  const insights = await fetchJson(`/api/v2/inbox-placement-analytics/deliverability-insights`, {
    method: "POST",
    body: JSON.stringify({ test_id: testId }),
  }).catch((e: any) => ({ error: String(e) }));

  const reports = { stats, perRecipient, domainReports, insights };
  const payload = { test_id: testId, status, create_body: createBody, reports };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(payload, null, 2));
  console.error(`\nWrote ${out}`);

  // --- Placement summary ---
  const s = Array.isArray(stats) ? stats.find((r: any) => r.test_id === testId) ?? stats[0] : undefined;
  if (s && !("error" in (stats as any))) {
    const inboxPct = Number(s.inbox_percent ?? 0);
    const verdict =
      inboxPct > 90 ? "GREAT — ship more" :
      inboxPct >= 70 ? "CONCERN — check spam-filter details below" :
      "RED — pause and fix auth + copy before sending more";
    console.error("\n--- Placement summary ---");
    console.error(`Seeds hit:   ${s.count}`);
    console.error(`Inbox:       ${s.inbox_percent}%  (${s.inbox_count})`);
    console.error(`Spam:        ${s.spam_percent}%  (${s.spam_count})`);
    console.error(`Categories:  ${s.category_percent}%  (${s.category_count})`);
    console.error(`Verdict:     ${verdict}  [>90% great, 70-90% concern, <70% red]`);
  }

  // --- Auth summary (replaces dkim-details / spf-details reports) ---
  const received = (perRecipient as any[]).filter((r) => r.record_type === 2);
  if (received.length) {
    const pct = (k: string) => {
      const known = received.filter((r) => r[k] !== null && r[k] !== undefined);
      if (!known.length) return "n/a";
      return `${((known.filter((r) => r[k] === true).length / known.length) * 100).toFixed(0)}%`;
    };
    console.error("\n--- Auth pass rates (per received seed email) ---");
    console.error(`SPF pass:    ${pct("spf_pass")}`);
    console.error(`DKIM pass:   ${pct("dkim_pass")}`);
    console.error(`DMARC pass:  ${pct("dmarc_pass")}`);
  }

  // --- SpamAssassin + blacklist summary (per sending domain) ---
  const domRows = (domainReports as any[]).filter((r) => r.domain);
  if (domRows.length) {
    console.error("\n--- SpamAssassin + blacklist (per sending domain) ---");
    for (const r of domRows) {
      const bl = r.blacklist_report;
      const blNote = bl?.is_blacklisted ? `BLACKLISTED on ${bl.blacklisted_count}` : "clean";
      console.error(`${String(r.domain).padEnd(30)} SA score: ${r.spam_assassin_score}   blacklists: ${blNote}`);
      const rules = r.spam_assassin_report?.report ?? [];
      for (const rule of rules.slice(0, 5)) {
        console.error(`    ${rule.name} (${rule.score}): ${String(rule.description).slice(0, 80)}`);
      }
    }
  }

  // --- Insights ---
  if (Array.isArray(insights) && insights.length) {
    console.error("\n--- Deliverability insights (sender ESP × recipient ESP) ---");
    console.error(JSON.stringify(insights, null, 2).slice(0, 800));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
