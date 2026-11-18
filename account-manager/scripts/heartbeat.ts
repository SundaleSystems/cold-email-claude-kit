#!/usr/bin/env tsx
/**
 * Heartbeat: confirms today's daily run actually happened. Runs a few hours after the
 * daily job. If state/<today>.json is missing, posts a red alert to Slack so a silently
 * failing launchd job never goes unnoticed.
 *
 *   npx tsx account-manager/scripts/heartbeat.ts --client=example-client
 */
import { existsSync } from "fs";
import { resolve } from "path";
import { clientDir, flag, slack, today } from "./_lib";

async function main() {
  const client = flag("client", "example-client")!;
  const p = resolve(clientDir(client), "state", `${today()}.json`);
  if (existsSync(p)) { console.log(`heartbeat ok — ${p} exists`); return; }
  const msg = `🔴 *${client} account manager — ${today()}*: the daily run did NOT produce a state file. Check \`account-manager/logs/daily.log\` and \`launchctl list | grep coldemailkit\`.`;
  console.log(msg);
  await slack(msg);
}
main().catch((e) => { console.error(e); process.exit(1); });
