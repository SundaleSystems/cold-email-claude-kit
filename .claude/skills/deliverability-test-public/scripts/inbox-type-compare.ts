#!/usr/bin/env tsx
/**
 * Compare reply / bounce rates across inbox types (Gmail / Outlook / SMTP)
 * for an Instantly workspace.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/inbox-type-compare.ts [--days=7]
 */

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
  return {
    days: Number(get("--days") ?? 7),
  };
}

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (resp.status === 429 || resp.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`${resp.status}: ${t.slice(0, 200)}`);
    }
    return resp.json();
  }
  throw new Error("exhausted retries");
}

async function listEmailAccounts(): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const url = new URL(`${API_BASE}/api/v2/accounts`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("starting_after", cursor);
    const data = await fetchJson(url.toString());
    const items: any[] = data.items ?? [];
    if (!items.length) break;
    all.push(...items);
    if (!data.next_starting_after) break;
    cursor = data.next_starting_after;
  }
  return all;
}

async function accountDailyStats(startDate: string, endDate: string): Promise<any[]> {
  // Per-account per-day rows: { date, email_account, sent, bounced, replies, ... }
  const url = new URL(`${API_BASE}/api/v2/accounts/analytics/daily`);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  const data = await fetchJson(url.toString());
  return Array.isArray(data) ? data : [];
}

function classifyType(providerCode: number | undefined): string {
  // Instantly provider_code: 1 = custom IMAP/SMTP, 2 = Google, 3 = Microsoft, 4/8 = other
  if (providerCode === 2) return "G Suite / Gmail";
  if (providerCode === 3) return "Office365 / Outlook";
  return "SMTP";
}

async function main() {
  const { days } = parseArgs();
  const endDate = dateNDaysAgo(0);
  const startDate = dateNDaysAgo(days);
  console.error(`Pulling inbox inventory + account stats from ${startDate} to ${endDate}...`);

  const accounts = await listEmailAccounts();
  const accountTypeByEmail = new Map<string, string>();
  for (const a of accounts) {
    accountTypeByEmail.set(a.email, classifyType(a.provider_code));
  }
  console.error(`  ${accounts.length} inbox accounts, ${new Set(accountTypeByEmail.values()).size} types`);

  type Bucket = { inboxes: Set<string>; sent: number; replies: number; bounces: number };
  const buckets = new Map<string, Bucket>();
  const bucketFor = (k: string) => {
    if (!buckets.has(k))
      buckets.set(k, { inboxes: new Set(), sent: 0, replies: 0, bounces: 0 });
    return buckets.get(k)!;
  };

  // Account-level daily analytics already span ALL campaigns (including
  // subsequences), so there is no need to enumerate campaigns and pull
  // per-campaign stats — one call covers the whole workspace.
  const rows = await accountDailyStats(startDate, endDate);
  console.error(`  ${rows.length} account-day rows`);
  for (const r of rows) {
    const email = r.email_account;
    const type = accountTypeByEmail.get(email) ?? "unknown";
    const b = bucketFor(type);
    b.inboxes.add(email);
    b.sent += Number(r.sent ?? 0);
    b.replies += Number(r.replies ?? 0);
    b.bounces += Number(r.bounced ?? 0);
  }

  // Print table
  console.log(`\nInbox Type Comparison — last ${days} days\n`);
  console.log(
    `Type                 Inboxes    Sent    Replies  Bounces   Reply %   Bounce %`
  );
  console.log(
    `------------------   -------   ------   ------   ------   -------   --------`
  );

  let totalSent = 0,
    totalReplies = 0,
    totalBounces = 0,
    totalInboxes = 0;

  const sorted = [...buckets.entries()].sort((a, b) => b[1].sent - a[1].sent);
  for (const [type, b] of sorted) {
    const replyPct = b.sent ? ((b.replies / b.sent) * 100).toFixed(2) : "0.00";
    const bouncePct = b.sent ? ((b.bounces / b.sent) * 100).toFixed(2) : "0.00";
    console.log(
      `${type.padEnd(18)}    ${String(b.inboxes.size).padStart(5)}   ${String(b.sent).padStart(6)}   ${String(b.replies).padStart(6)}   ${String(b.bounces).padStart(6)}   ${replyPct.padStart(6)}%   ${bouncePct.padStart(6)}%`
    );
    totalSent += b.sent;
    totalReplies += b.replies;
    totalBounces += b.bounces;
    totalInboxes += b.inboxes.size;
  }

  console.log(
    `------------------   -------   ------   ------   ------   -------   --------`
  );
  const tReply = totalSent ? ((totalReplies / totalSent) * 100).toFixed(2) : "0.00";
  const tBounce = totalSent ? ((totalBounces / totalSent) * 100).toFixed(2) : "0.00";
  console.log(
    `TOTAL                 ${String(totalInboxes).padStart(5)}   ${String(totalSent).padStart(6)}   ${String(totalReplies).padStart(6)}   ${String(totalBounces).padStart(6)}   ${tReply.padStart(6)}%   ${tBounce.padStart(6)}%`
  );

  // Takeaways
  if (sorted.length > 1) {
    const best = [...sorted].sort(
      (a, b) => b[1].replies / Math.max(b[1].sent, 1) - a[1].replies / Math.max(a[1].sent, 1)
    )[0];
    const worst = [...sorted].sort(
      (a, b) => a[1].replies / Math.max(a[1].sent, 1) - b[1].replies / Math.max(b[1].sent, 1)
    )[0];
    console.log(`\nTakeaways:`);
    console.log(
      `- Best reply rate: ${best[0]} (${((best[1].replies / Math.max(best[1].sent, 1)) * 100).toFixed(2)}%)`
    );
    console.log(
      `- Worst reply rate: ${worst[0]} (${((worst[1].replies / Math.max(worst[1].sent, 1)) * 100).toFixed(2)}%)`
    );
    const highBounce = sorted.filter((s) => s[1].sent > 500 && s[1].bounces / s[1].sent > 0.03);
    for (const [type, b] of highBounce) {
      console.log(
        `- ${type} has elevated bounce rate (${((b.bounces / b.sent) * 100).toFixed(2)}%) — run /email-deliverability-audit on these domains`
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
