-- SPEED TO CALL — phone-hunt log table.
--
-- Lives in the same "Speed to Lead" Supabase project as reply-gate. Safe
-- to paste into the same SQL Editor: it only creates its own table and
-- index, and is idempotent (re-runnable for schema changes).
--
-- NOTE — no pg_cron, no pg_net, no claim function here (unlike
-- reply-gate). The hunt is a single pass with no delayed send: the
-- webhook fires the whole pipeline in the background and the alert goes
-- out immediately. This table is a log + a one-shot dedup guard, nothing
-- more.

create table if not exists phone_hunt_log (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  campaign_id     text not null,
  lead_email      text not null,
  first_name      text,
  last_name       text,
  company_name    text,
  campaign_name   text,
  event_type      text,
  location_raw    text,
  city            text,
  state           text,
  linkedin_url    text,
  reply_excerpt   text,                  -- first ~500 chars of the cut reply, for audit
  candidates      jsonb,                 -- final scored list [{digits,score,type,sourceList,note}]
  source_status   jsonb,                 -- {signature:'ok:1', fps:'timeout', leadmagic:'ok:1', slack:'sent', gmail:'skipped'}
  mobiles_found   int not null default 0,
  others_found    int not null default 0,
  duration_ms     int,
  status          text not null default 'processing',  -- processing | done | error
  error           text
);

-- One-shot guard: the first positive event per (campaign, lead) wins.
-- Webhook retries and a second "interested" event are harmless no-ops.
create unique index if not exists phone_hunt_one_shot
  on phone_hunt_log (campaign_id, lead_email);

-- Service-role only, same posture as reply-gate: RLS on, zero policies,
-- so anon/authenticated get nothing and the Edge Function (service role)
-- bypasses RLS entirely.
alter table phone_hunt_log enable row level security;
