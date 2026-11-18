#!/usr/bin/env tsx
/**
 * Create a new campaign by copying an existing campaign's sequence + settings,
 * pointing it at a chosen inbox pool and daily limit. Created in DRAFT; the
 * daily agent activates it only if the runbook allows.
 *
 * Usage:
 *   npx tsx account-manager/scripts/clone-campaign.ts --from=<campaign id> --name="..." \
 *     [--inboxes=a@x.com,b@y.com | --all-healthy] [--daily-limit=1500] [--activate]
 */
import { api, flag, hasFlag, listAll } from "./_lib";

export async function healthyInboxes(opts: { excludeTags?: string[]; minScore?: number } = {}): Promise<string[]> {
  const accounts = await listAll("/accounts?include_tags=true");
  const ex = new Set((opts.excludeTags ?? []).map((t) => t.toLowerCase()));
  return accounts
    .filter((a) => a.status === 1 && a.warmup_status === 1 && !a.setup_pending)
    .filter((a) => (a.stat_warmup_score ?? 100) >= (opts.minScore ?? 90))
    .filter((a) => !(a.tags ?? []).some((t: any) => ex.has(String(t.label).toLowerCase())))
    .map((a) => a.email);
}

export async function cloneCampaign(fromId: string, name: string, inboxes: string[], dailyLimit: number): Promise<{ id: string; name: string }> {
  const src = await api(`/campaigns/${fromId}`);
  const body: any = {
    name,
    campaign_schedule: {
      schedules: (src.campaign_schedule?.schedules ?? []).map((s: any) => ({ name: s.name, timing: s.timing, days: s.days, timezone: s.timezone })),
    },
    sequences: src.sequences,
    email_list: inboxes,
    daily_limit: dailyLimit,
    stop_on_reply: src.stop_on_reply ?? true,
    stop_for_company: src.stop_for_company ?? false,
    open_tracking: src.open_tracking ?? false,
    link_tracking: src.link_tracking ?? false,
    text_only: src.text_only ?? true,
    first_email_text_only: src.first_email_text_only ?? true,
    insert_unsubscribe_header: src.insert_unsubscribe_header ?? false,
    stop_on_auto_reply: src.stop_on_auto_reply ?? false,
  };
  if (src.pl_value != null) body.pl_value = src.pl_value;
  const created = await api("/campaigns", { method: "POST", body: JSON.stringify(body) });
  return { id: created.id, name: created.name };
}

async function main() {
  const from = flag("from"); const name = flag("name");
  if (!from || !name) { console.error("Usage: --from=<id> --name=... [--inboxes=... | --all-healthy] [--daily-limit=N] [--activate]"); process.exit(1); }
  let inboxes = (flag("inboxes") ?? "").split(",").filter(Boolean);
  if (hasFlag("all-healthy")) inboxes = await healthyInboxes();
  if (!inboxes.length) { console.error("No inboxes selected"); process.exit(1); }
  const c = await cloneCampaign(from, name, inboxes, Number(flag("daily-limit") ?? 1000));
  console.log(`Created DRAFT ${c.id} "${c.name}" with ${inboxes.length} inboxes`);
  if (hasFlag("activate")) { await api(`/campaigns/${c.id}/activate`, { method: "POST" }); console.log("Activated."); }
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
