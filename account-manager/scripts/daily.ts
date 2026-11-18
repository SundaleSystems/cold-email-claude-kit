#!/usr/bin/env tsx
/**
 * Daily account-manager run for one client.
 *
 *   1. Pull the live Instantly state (inboxes, campaigns, leads, send volume).
 *   2. Apply the rules in the client's runbook.json:
 *        R1  inbox health            → report, escalate if >10% of fleet unhealthy
 *        R2  bounce guard            → pause any campaign over max_bounce_rate_7d
 *        R3  a campaign must run     → activate the best paused campaign, else build one from approved stock
 *        R4  volume floor            → if sends < min_emails_per_day: raise limits, top up leads, clone a campaign
 *        R5  lead runway             → if uncontacted leads < min_runway_days of demand: top up / escalate NEED_LEADS
 *        R6  zombies                 → pause active campaigns with no inboxes or no leads
 *   3. Execute only what autonomy.* allows; everything else becomes an escalation.
 *   4. Write state/<date>.json, append ops-log.md, post a Slack summary.
 *
 * Usage:
 *   npx tsx account-manager/scripts/daily.ts --client=example-client [--dry] [--no-slack]
 *
 * Exit code 0 always (so launchd doesn't retry); the JSON summary on stdout has `escalations`.
 */
import { resolve } from "path";
import { writeFileSync, mkdirSync } from "fs";
import {
  api, ApiError, CAMPAIGN_STATUS, appendOpsLog, clientDir, daysAgo, flag, hasFlag, isWeekday,
  listAll, listCampaignLeads, loadRunbook, pct, readState, saveRunbook, slack, today, writeState, type LeadStock, type Runbook,
} from "./_lib";
import { addLeads, buildLeads } from "./add-leads";
import { cloneCampaign, healthyInboxes } from "./clone-campaign";
import { activate, pause, setDailyLimit, setInboxes } from "./campaign";

const CLIENT = flag("client", "example-client")!;
const DRY = hasFlag("dry");
const NO_SLACK = hasFlag("no-slack");

type Esc = { code: string; text: string };
const actions: string[] = [];
const findings: string[] = [];
const escalations: Esc[] = [];
const act = (s: string) => { actions.push(s); console.log("ACTION:", s); };
const note = (s: string) => { findings.push(s); console.log("NOTE:  ", s); };
const esc = (code: string, text: string) => { escalations.push({ code, text }); console.log("ESCALATE:", code, text); };

interface CampaignView {
  id: string; name: string; status: number; status_label: string; inboxes: number; daily_limit: number;
  leads: number; uncontacted: number; in_sequence: number; completed: number; bounced_leads: number;
  sent: number; bounced: number; replies: number; created: string; updated: string;
  bounce_7d?: { sent: number; bounced: number; rate: number; basis: string };
}

async function campaignView(c: any): Promise<CampaignView> {
  let a = await api(`/campaigns/analytics?id=${c.id}`); a = Array.isArray(a) ? a[0] ?? {} : a;
  const leads = await listCampaignLeads(c.id);
  const uncontacted = leads.filter((l) => l.status === 1 && !l.timestamp_last_contact).length;
  const in_sequence = leads.filter((l) => l.status === 1 && !!l.timestamp_last_contact).length;
  return {
    id: c.id, name: c.name, status: c.status, status_label: CAMPAIGN_STATUS[c.status] ?? String(c.status),
    inboxes: (c.email_list ?? []).length, daily_limit: c.daily_limit ?? 0,
    leads: leads.length, uncontacted, in_sequence,
    completed: leads.filter((l) => l.status === 3).length, bounced_leads: leads.filter((l) => l.status === -1).length,
    sent: a.emails_sent_count ?? 0, bounced: a.bounced_count ?? 0, replies: a.reply_count_unique ?? 0,
    created: (c.timestamp_created ?? "").slice(0, 10), updated: (c.timestamp_updated ?? "").slice(0, 10),
  };
}

function bounce7d(v: CampaignView): CampaignView["bounce_7d"] {
  // Compare against the oldest snapshot within the last 7 days; fall back to lifetime for young campaigns.
  for (let d = 7; d >= 1; d--) {
    const s = readState(CLIENT, daysAgo(d));
    const prev = s?.campaigns?.find((x: any) => x.id === v.id);
    if (prev) {
      const sent = v.sent - prev.sent, bounced = v.bounced - prev.bounced;
      return { sent, bounced, rate: sent ? bounced / sent : 0, basis: `vs ${daysAgo(d)} snapshot` };
    }
  }
  const ageDays = (Date.now() - new Date(v.created).getTime()) / 86400000;
  if (ageDays <= 14) return { sent: v.sent, bounced: v.bounced, rate: v.sent ? v.bounced / v.sent : 0, basis: "lifetime (campaign <14d old)" };
  return undefined;
}

async function main() {
  const rb: Runbook = loadRunbook(CLIENT);
  const T = rb.targets, A = rb.autonomy;
  const date = today();
  console.log(`== account-manager daily — ${CLIENT} — ${date}${DRY ? " (DRY RUN)" : ""}`);

  // ---------- collect ----------
  const accounts = await listAll("/accounts?include_tags=true");
  const excl = new Set(rb.inbox_pool.exclude_tags.map((t) => t.toLowerCase()));
  const healthy = accounts.filter((a) => a.status === 1 && a.warmup_status === 1 && (a.stat_warmup_score ?? 100) >= T.min_warmup_score
    && !(a.tags ?? []).some((t: any) => excl.has(String(t.label).toLowerCase())));
  const unhealthy = accounts.filter((a) => a.status !== 1 || a.warmup_status !== 1 || (a.stat_warmup_score ?? 100) < T.min_warmup_score);
  const fleetCap = healthy.reduce((s, a) => s + (a.daily_limit ?? 0), 0);
  const inboxLimit = new Map(accounts.map((a) => [a.email, a.daily_limit ?? 0]));

  const allCampaigns = await listAll("/campaigns");
  const relevant = allCampaigns.filter((c) => !rb.ignore_campaign_ids.includes(c.id) && [0, 1, 2, 4, -1, -2].includes(c.status));
  const views: CampaignView[] = [];
  for (const c of relevant) views.push(await campaignView(c));
  for (const v of views) v.bounce_7d = bounce7d(v);
  const rawById = new Map(relevant.map((c) => [c.id, c]));

  const daily: any[] = await api(`/campaigns/analytics/daily?start_date=${daysAgo(14)}&end_date=${date}`);
  const sentOn = (ymd: string) => daily.find((r) => r.date === ymd)?.sent ?? 0;
  let lastSendDay = daysAgo(1); for (let i = 1; !isWeekday(lastSendDay) && i < 7; i++) lastSendDay = daysAgo(i + 1);
  const sentYesterday = sentOn(lastSendDay);
  const weekdays = Array.from({ length: 10 }, (_, i) => daysAgo(i + 1)).filter(isWeekday).slice(0, 5);
  const avg5 = Math.round(weekdays.reduce((s, d) => s + sentOn(d), 0) / Math.max(1, weekdays.length));

  const isLive = (v: CampaignView) => v.status === 1 && v.inboxes > 0 && (v.uncontacted + v.in_sequence) > 0;
  const live = () => views.filter(isLive);
  const capToday = () => live().reduce((s, v) => {
    const raw = rawById.get(v.id); const poolCap = (raw?.email_list ?? []).reduce((x: number, e: string) => x + (inboxLimit.get(e) ?? 0), 0);
    return s + Math.min(v.daily_limit || poolCap, poolCap);
  }, 0);
  const demandPerDay = Math.ceil(T.min_emails_per_day / T.avg_touches_per_lead);
  const runwayDays = () => live().reduce((s, v) => s + v.uncontacted, 0) / demandPerDay;

  note(`Inboxes: ${accounts.length} total, ${healthy.length} healthy in pool, fleet cap ${fleetCap}/day. Unhealthy: ${unhealthy.length}.`);
  note(`Sent ${lastSendDay}: ${sentYesterday} (target ${T.min_emails_per_day}); 5-weekday avg ${avg5}.`);
  for (const v of views) note(`${v.status_label.padEnd(16)} ${v.name.slice(0, 48).padEnd(48)} inboxes=${v.inboxes} limit=${v.daily_limit} leads=${v.leads} uncontacted=${v.uncontacted} in_seq=${v.in_sequence} sent=${v.sent} bounce=${pct(v.bounced, v.sent)} replies=${v.replies}`);

  // ---------- R1 inbox health ----------
  if (unhealthy.length) {
    const sample = unhealthy.slice(0, 8).map((a) => `${a.email} (status ${a.status}/warmup ${a.warmup_status}/score ${a.stat_warmup_score ?? "?"})`).join(", ");
    if (unhealthy.length > accounts.length * 0.1) esc("INBOX_HEALTH", `${unhealthy.length}/${accounts.length} inboxes unhealthy: ${sample}. Run /email-deliverability-audit.`);
    else note(`Unhealthy inboxes (${unhealthy.length}): ${sample}`);
  }

  // ---------- R2 bounce guard ----------
  for (const v of views.filter((x) => x.status === 1)) {
    const b = v.bounce_7d;
    if (b && b.sent >= 100 && b.rate > T.max_bounce_rate_7d) {
      if (A.may_pause_campaigns && !DRY) await pause(v.id);
      v.status = 2; v.status_label = "paused";
      act(`Paused "${v.name}" — bounce ${pct(b.bounced, b.sent)} over 7d (${b.basis}), above ${T.max_bounce_rate_7d * 100}% limit.`);
      esc("BOUNCE", `"${v.name}" paused for bounces (${b.bounced}/${b.sent}). Re-verify its remaining leads with /millionverifier before resuming.`);
    }
  }

  // ---------- R6 zombies ----------
  for (const v of views.filter((x) => x.status === 1 && (x.inboxes === 0 || x.leads === 0))) {
    if (A.may_pause_campaigns && !DRY) await pause(v.id);
    v.status = 2; v.status_label = "paused";
    act(`Paused "${v.name}" — active but ${v.inboxes === 0 ? "no inboxes" : "no leads"} (zombie).`);
  }

  // ---------- helper: top up from approved stock ----------
  const stockUsed: string[] = [];
  async function topUpFromStock(reason: string): Promise<number> {
    let added = 0;
    for (const s of rb.lead_stock.filter((x) => x.status === "approved")) {
      if (s.verified_date && (Date.now() - new Date(s.verified_date).getTime()) / 86400000 > (T.max_verification_age_days ?? 30)) {
        s.status = "needs_verification"; s.note = `${s.note ?? ""} | ${date}: verification from ${s.verified_date} is older than ${T.max_verification_age_days ?? 30} days, re-run /millionverifier`.trim();
        esc("STALE_STOCK", `Stock "${s.id}" was verified on ${s.verified_date}; too old to send. Re-verify before use.`); if (!DRY) saveRunbook(CLIENT, rb); continue;
      }
      if (runwayDays() >= T.min_runway_days && capToday() >= T.min_emails_per_day && live().length) break;
      let leads: any[];
      try { leads = buildLeads(s.path, s.column_map ?? {}, A.max_leads_per_upload).leads; }
      catch (e: any) { esc("STOCK_FILE", `Lead stock "${s.id}" unreadable: ${e.message}`); continue; }
      // Prefer an existing live campaign that was cloned from the same copy source; else clone one.
      let target = views.find((v) => v.status === 1 && v.inboxes > 0 && (v.id === s.copy_source_campaign_id || (s.campaign_name && v.name === s.campaign_name)));
      let createdNew = false;
      if (!target) {
        if (!A.may_clone_campaign_from_approved_stock || !s.copy_source_campaign_id) { esc("NEED_CAMPAIGN", `Stock "${s.id}" is approved but has no live campaign to join and cloning is off.`); continue; }
        const pool = await healthyInboxes({ excludeTags: rb.inbox_pool.exclude_tags, minScore: T.min_warmup_score });
        const limit = Math.max(100, Math.min(T.min_emails_per_day, fleetCap - capToday()));
        const name = s.campaign_name ?? `${s.id} | ${date}`;
        if (DRY) { act(`[dry] Would clone campaign from ${s.copy_source_campaign_id} as "${name}" (${pool.length} inboxes, limit ${limit}).`); target = { id: "dry", name, status: 0, status_label: "draft", inboxes: pool.length, daily_limit: limit, leads: 0, uncontacted: 0, in_sequence: 0, completed: 0, bounced_leads: 0, sent: 0, bounced: 0, replies: 0, created: date, updated: date }; views.push(target); }
        else {
          const c = await cloneCampaign(s.copy_source_campaign_id, name, pool, limit);
          target = { id: c.id, name: c.name, status: 0, status_label: "draft", inboxes: pool.length, daily_limit: limit, leads: 0, uncontacted: 0, in_sequence: 0, completed: 0, bounced_leads: 0, sent: 0, bounced: 0, replies: 0, created: date, updated: date };
          views.push(target); rawById.set(c.id, { email_list: pool });
          act(`Created campaign "${name}" (${c.id}) from ${s.copy_source_campaign_id}: ${pool.length} inboxes, daily limit ${limit}.`);
        }
        createdNew = true;
      }
      const r = DRY ? { attempted: leads.length, uploaded: leads.length, duplicated: 0, invalid: 0, skipped: 0, blocklist: 0 } : await addLeads(target.id, leads, { reason } as any);
      if (r.error) {
        if (/lead limit|limit reached/i.test(r.error)) esc("PLAN_LEAD_LIMIT", `Instantly plan lead cap hit while adding "${s.id}" (${r.error}). Options: delete leads from completed campaigns older than 60 days, or upgrade the plan.`);
        else esc("UPLOAD_ERROR", `Adding "${s.id}" to "${target.name}" failed: ${r.error}`);
        continue;
      }
      act(`Added ${r.uploaded} leads from "${s.id}" to "${target.name}" (${r.duplicated + r.skipped} already in workspace, ${r.invalid} invalid)${r.remaining_in_plan != null ? `; plan has ${r.remaining_in_plan} lead slots left` : ""}. Reason: ${reason}.`);
      target.uncontacted += r.uploaded; target.leads += r.uploaded; added += r.uploaded;
      s.status = "used"; s.note = `${s.note ?? ""} | used ${date}: ${r.uploaded} uploaded, ${r.duplicated + r.skipped} dupes`.trim(); stockUsed.push(s.id);
      if (createdNew) {
        if (r.uploaded === 0) {
          if (!DRY) { await api(`/campaigns/${target.id}`, { method: "DELETE" }); views.splice(views.indexOf(target), 1); }
          act(`"${target.name}" got 0 new leads (all already in workspace) → deleted the empty draft.`); continue;
        }
        if (A.may_activate_campaigns) { if (!DRY) await activate(target.id); target.status = 1; target.status_label = "active"; act(`Activated "${target.name}".`); }
        else esc("ACTIVATE", `"${target.name}" is ready in DRAFT with ${r.uploaded} leads — press Resume in Instantly.`);
      }
    }
    if (!DRY && stockUsed.length) saveRunbook(CLIENT, rb);
    return added;
  }

  // ---------- R2b paused campaigns that still hold fresh leads ----------
  for (const v of views.filter((x) => x.status === 2 && x.uncontacted >= 200 && !(x.bounce_7d && x.bounce_7d.rate > T.max_bounce_rate_7d))) {
    const allowed = (rb.resume_allowlist ?? []).includes(v.id);
    if (allowed && (sentYesterday < T.min_emails_per_day || capToday() < T.min_emails_per_day)) {
      if (v.inboxes === 0) {
        const pool = await healthyInboxes({ excludeTags: rb.inbox_pool.exclude_tags, minScore: T.min_warmup_score });
        if (!DRY) await setInboxes(v.id, pool); v.inboxes = pool.length; rawById.set(v.id, { ...(rawById.get(v.id) ?? {}), email_list: pool });
        act(`Attached ${pool.length} healthy inboxes to "${v.name}".`);
      }
      if (A.may_activate_campaigns) { if (!DRY) await activate(v.id); v.status = 1; v.status_label = "active"; act(`Resumed "${v.name}" (${v.uncontacted} fresh leads; on resume_allowlist).`); }
    } else if (!allowed) {
      esc("RESUME_CANDIDATE", `"${v.name}" is paused with ${v.uncontacted} fresh leads${v.inboxes === 0 ? " and no inboxes" : ""}. Add its id to resume_allowlist in runbook.json and the agent will attach inboxes and resume it when volume is short.`);
    }
  }

  // ---------- R3 a campaign must be running ----------
  if (!live().length) {
    const cand = views.filter((v) => v.status === 2 && v.inboxes > 0 && v.uncontacted > 0 && !(v.bounce_7d && v.bounce_7d.rate > T.max_bounce_rate_7d))
      .sort((a, b) => b.uncontacted - a.uncontacted)[0];
    if (cand) {
      if (A.may_activate_campaigns) { if (!DRY) await activate(cand.id); cand.status = 1; cand.status_label = "active"; act(`No campaign was running → resumed "${cand.name}" (${cand.uncontacted} uncontacted leads).`); }
      else esc("ACTIVATE", `No campaign is running. "${cand.name}" has ${cand.uncontacted} uncontacted leads — press Resume.`);
    } else {
      note("No campaign running and no paused campaign has leads left → building from stock.");
      await topUpFromStock("nothing running");
      if (!live().length) esc("NOTHING_RUNNING", "No campaign is sending and no approved lead stock could start one. A new list is required today.");
    }
  }

  // ---------- R4 volume floor ----------
  const volumeShort = sentYesterday < T.min_emails_per_day || capToday() < T.min_emails_per_day;
  if (volumeShort) {
    note(`Volume short: sent ${sentYesterday}, capacity today ${capToday()}, target ${T.min_emails_per_day}.`);
    // a) raise daily limits where leads exist but the campaign limit is the cap
    for (const v of live()) {
      const raw = rawById.get(v.id); const poolCap = (raw?.email_list ?? []).reduce((x: number, e: string) => x + (inboxLimit.get(e) ?? 0), 0);
      const want = Math.min(poolCap, T.min_emails_per_day, v.daily_limit + T.max_daily_limit_step);
      if (A.may_raise_daily_limit && v.daily_limit < want && v.uncontacted + v.in_sequence > v.daily_limit) {
        if (!DRY) await setDailyLimit(v.id, want);
        act(`Raised daily limit on "${v.name}" ${v.daily_limit} → ${want} (inbox pool cap ${poolCap}).`); v.daily_limit = want;
      }
    }
    // a2) Instantly's separate "new leads per day" cap (daily_max_leads) silently throttles first touches
    for (const v of live()) {
      const raw = rawById.get(v.id); const cap = raw?.daily_max_leads;
      if (A.may_raise_daily_limit && typeof cap === "number" && cap > 0 && cap < v.daily_limit && v.uncontacted > cap) {
        if (!DRY) await api(`/campaigns/${v.id}`, { method: "PATCH", body: JSON.stringify({ daily_max_leads: v.daily_limit }) });
        act(`Raised new-leads-per-day cap on "${v.name}" ${cap} → ${v.daily_limit} (it was throttling first touches to ${cap}/day).`);
      }
    }
    // b) more leads / new campaign
    if (capToday() < T.min_emails_per_day || runwayDays() < T.min_runway_days) await topUpFromStock("volume below target");
  }

  // ---------- R5 runway ----------
  const runway = runwayDays();
  const totalUncontacted = live().reduce((s, v) => s + v.uncontacted, 0);
  note(`Runway: ${totalUncontacted} uncontacted leads across live campaigns ≈ ${runway.toFixed(1)} days at ${demandPerDay} new leads/day (min ${T.min_runway_days}).`);
  if (runway < T.min_runway_days) {
    const pending = rb.lead_stock.filter((s) => s.status !== "used" && s.status !== "approved")
      .map((s) => `• ${s.id} — ${s.status}: ${s.note ?? ""}`).join("\n");
    esc("NEED_LEADS", `Lead runway is ${runway.toFixed(1)} days (need ${T.min_runway_days}). Approved stock is exhausted. ` +
      (A.may_spend_on_lead_sourcing ? "Auto-sourcing is ON: run /vayne-lead-pipeline." : "Auto-sourcing is OFF: a human must approve a new list build (/vayne-lead-pipeline) or unblock stock:") + (pending ? "\n" + pending : ""));
    mkdirSync(resolve(clientDir(CLIENT), "requests"), { recursive: true });
    writeFileSync(resolve(clientDir(CLIENT), "requests", "needs-leads.json"), JSON.stringify({ date, runway_days: runway, demand_per_day: demandPerDay, pending_stock: rb.lead_stock.filter((s) => s.status !== "used") }, null, 2));
  }

  // ---------- persist + report ----------
  const summary = {
    date, client: CLIENT, dry_run: DRY,
    sent_last_send_day: sentYesterday, last_send_day: lastSendDay, avg_5_weekdays: avg5, target: T.min_emails_per_day,
    capacity_today: capToday(), fleet_cap: fleetCap, inboxes: accounts.length, healthy_inboxes: healthy.length, unhealthy_inboxes: unhealthy.length,
    runway_days: Number(runway.toFixed(1)), uncontacted: totalUncontacted,
    campaigns: views, actions, findings, escalations, stock_used: stockUsed,
  };
  if (!DRY) { writeState(CLIENT, date, summary); writeState(CLIENT, "latest", summary); }

  const liveLine = live().map((v) => `${v.name.slice(0, 40)} (limit ${v.daily_limit}, ${v.uncontacted} fresh)`).join("; ") || "none";
  const status = escalations.length ? "🔴" : actions.length ? "🟡" : "🟢";
  const msg = [
    `${status} *Outbound — ${date}*${DRY ? " (dry run)" : ""}`,
    `Sent ${lastSendDay}: *${sentYesterday}* / ${T.min_emails_per_day} target · 5-day avg ${avg5} · capacity today ${capToday()} · inboxes ${healthy.length}/${accounts.length} healthy`,
    `Live: ${liveLine}`,
    `Runway: ${totalUncontacted} fresh leads ≈ ${runway.toFixed(1)} days`,
    actions.length ? `*Did:*\n${actions.map((a) => `• ${a}`).join("\n")}` : "*Did:* nothing needed",
    escalations.length ? `*Needs you:*\n${escalations.map((e) => `• [${e.code}] ${e.text}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  console.log("\n" + msg);
  if (!NO_SLACK && !DRY) await slack(msg, { channel: rb.slack_channel });

  if (!DRY) appendOpsLog(CLIENT, `\n## ${date}\n- Sent ${lastSendDay}: ${sentYesterday} (target ${T.min_emails_per_day}), 5-day avg ${avg5}, capacity ${capToday()}, runway ${runway.toFixed(1)}d\n` +
    actions.map((a) => `- DID: ${a}`).join("\n") + (actions.length ? "\n" : "") +
    escalations.map((e) => `- ESCALATED [${e.code}]: ${e.text.split("\n")[0]}`).join("\n") + (escalations.length ? "\n" : ""));

  console.log("\n" + JSON.stringify({ date, actions: actions.length, escalations: escalations.map((e) => e.code), sent: sentYesterday, capacity: capToday(), runway: Number(runway.toFixed(1)) }));
}

main().catch(async (e) => {
  const text = e instanceof ApiError ? `${e.status} ${e.path}: ${e.body.slice(0, 300)}` : String(e?.stack ?? e);
  console.error("FATAL:", text);
  if (!NO_SLACK) await slack(`🔴 *Outbound — ${today()}*: daily run FAILED\n\`\`\`${text.slice(0, 1500)}\`\`\``);
  appendOpsLog(CLIENT, `\n## ${today()}\n- RUN FAILED: ${text.split("\n")[0]}\n`);
  process.exit(0);
});
