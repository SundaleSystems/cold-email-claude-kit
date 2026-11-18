#!/usr/bin/env tsx
/**
 * Bulk enable/disable warmup on Instantly sending accounts.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/set-warmup.ts --mode=enable --tag=new --warmup-per-day=40 --ramp=4
 *   npx tsx scripts/set-warmup.ts --mode=disable --tag=active
 *   npx tsx scripts/set-warmup.ts --mode=insurance --tag=insurance
 *
 * Selector flags (pick one): --all, --emails=a@x.com,b@y.com (--ids= alias),
 *   --domain=example.com, --tag=active, --ids-from-csv=path
 * Mode:
 *   --mode=enable       warmup on, full ramp (default: limit 40/day, increment "4")
 *   --mode=disable      warmup off
 *   --mode=insurance    warmup on, low maintenance (limit 15/day, increment "disabled")
 *
 * How it works:
 *   enable/insurance — ONE bulk call to POST /accounts/warmup/enable {emails}
 *     (returns a background job that gets polled), then a per-account
 *     PATCH /accounts/{email} to apply { warmup: { limit, increment, reply_rate } }.
 *   disable — ONE bulk call to POST /accounts/warmup/disable {emails} + job poll.
 */

import {
  parseFlag,
  selectInboxes,
  runWithConcurrency,
  fetchJson,
  pollBackgroundJob,
} from "./_lib";

/**
 * Instantly's warmup `increment` is a STRING enum: "disabled" | "0".."4" —
 * the daily amount added to the sending limit (slow ramp), where "4" is the
 * fastest ramp supported. The old numeric daily_rampup values map as:
 * 0 → "disabled", 5+ → "4" (capped), 1-4 → same digit as a string.
 */
function toIncrement(ramp: number): string {
  if (!Number.isFinite(ramp) || ramp <= 0) return "disabled";
  return String(Math.min(Math.floor(ramp), 4));
}

async function main() {
  const args = process.argv.slice(2);
  const mode = parseFlag(args, "--mode");
  if (!mode || !["enable", "disable", "insurance"].includes(mode)) {
    console.error("Usage: --mode=enable|disable|insurance [selector flags]");
    process.exit(1);
  }

  const warmupPerDay = Number(parseFlag(args, "--warmup-per-day") ?? (mode === "insurance" ? 15 : 40));
  const ramp = Number(parseFlag(args, "--ramp") ?? (mode === "insurance" ? 0 : 4));
  const replyRate = Number(parseFlag(args, "--reply-rate") ?? 20);

  console.error(`Selecting inboxes...`);
  const inboxes = await selectInboxes(args);
  console.error(`Matched ${inboxes.length} inboxes. Mode: ${mode}`);

  if (inboxes.length === 0) {
    console.error("No inboxes matched; nothing to do.");
    return;
  }

  const emails = inboxes.map((i) => i.email);

  if (mode === "disable") {
    console.error(`Disabling warmup on ${emails.length} accounts (bulk).`);
    console.error(`Proceeding in 3s... (Ctrl+C to abort)`);
    await new Promise((r) => setTimeout(r, 3000));

    const job = await fetchJson(`/accounts/warmup/disable`, {
      method: "POST",
      body: JSON.stringify({ emails }),
    });
    const final = await pollBackgroundJob(job.id);
    console.error(`\nDone. Warmup disable job ${job.id} finished with status: ${final.status}.`);
    return;
  }

  // enable / insurance
  const warmupSettings = {
    limit: warmupPerDay,
    increment: toIncrement(ramp),
    reply_rate: replyRate,
  };
  console.error(`Warmup settings: ${JSON.stringify(warmupSettings)}`);
  console.error(`Proceeding in 3s... (Ctrl+C to abort)`);
  await new Promise((r) => setTimeout(r, 3000));

  // Step 1: one bulk call flips warmup ON for all selected accounts.
  console.error(`Enabling warmup on ${emails.length} accounts (bulk)...`);
  const job = await fetchJson(`/accounts/warmup/enable`, {
    method: "POST",
    body: JSON.stringify({ emails }),
  });
  const final = await pollBackgroundJob(job.id);
  console.error(`Warmup enable job ${job.id} status: ${final.status}.`);

  // Step 2: per-account PATCH to apply limit / increment / reply_rate.
  console.error(`Applying warmup settings per account...`);
  let ok = 0;
  let fail = 0;
  await runWithConcurrency(inboxes, 5, async (inbox, i) => {
    try {
      await fetchJson(`/accounts/${encodeURIComponent(inbox.email)}`, {
        method: "PATCH",
        body: JSON.stringify({ warmup: warmupSettings }),
      });
      ok++;
      if ((i + 1) % 20 === 0) console.error(`  ${i + 1}/${inboxes.length} processed`);
    } catch (err) {
      fail++;
      console.error(`  [${inbox.email}] ${String(err).slice(0, 200)}`);
    }
  });

  console.error(`\nDone. ${ok} updated, ${fail} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
