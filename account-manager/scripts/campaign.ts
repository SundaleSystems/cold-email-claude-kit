#!/usr/bin/env tsx
/**
 * One-off campaign controls used by the daily agent and by hand.
 *
 *   npx tsx account-manager/scripts/campaign.ts --id=<id> --activate
 *   npx tsx account-manager/scripts/campaign.ts --id=<id> --pause
 *   npx tsx account-manager/scripts/campaign.ts --id=<id> --daily-limit=1500
 *   npx tsx account-manager/scripts/campaign.ts --id=<id> --inboxes=all-healthy
 *   npx tsx account-manager/scripts/campaign.ts --list
 */
import { api, CAMPAIGN_STATUS, flag, hasFlag, listAll } from "./_lib";
import { healthyInboxes } from "./clone-campaign";

export const activate = (id: string) => api(`/campaigns/${id}/activate`, { method: "POST" });
export const pause = (id: string) => api(`/campaigns/${id}/pause`, { method: "POST" });
export const setDailyLimit = (id: string, daily_limit: number) => api(`/campaigns/${id}`, { method: "PATCH", body: JSON.stringify({ daily_limit }) });
export const setInboxes = (id: string, email_list: string[]) => api(`/campaigns/${id}`, { method: "PATCH", body: JSON.stringify({ email_list }) });

async function main() {
  if (hasFlag("list")) {
    const cs = await listAll("/campaigns");
    for (const c of cs.sort((a, b) => (b.timestamp_updated ?? "").localeCompare(a.timestamp_updated ?? "")))
      console.log(`${(CAMPAIGN_STATUS[c.status] ?? c.status).padEnd(18)} ${c.id}  ${c.name}`);
    return;
  }
  const id = flag("id"); if (!id) { console.error("--id required"); process.exit(1); }
  if (hasFlag("activate")) { await activate(id); console.log("activated"); }
  if (hasFlag("pause")) { await pause(id); console.log("paused"); }
  if (flag("daily-limit")) { await setDailyLimit(id, Number(flag("daily-limit"))); console.log("daily_limit set"); }
  if (flag("inboxes")) {
    const v = flag("inboxes")!;
    const list = v === "all-healthy" ? await healthyInboxes() : v.split(",").filter(Boolean);
    await setInboxes(id, list); console.log(`email_list set (${list.length})`);
  }
  const c = await api(`/campaigns/${id}`);
  console.log(`${c.name}: status=${CAMPAIGN_STATUS[c.status]} daily_limit=${c.daily_limit} inboxes=${(c.email_list ?? []).length}`);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
