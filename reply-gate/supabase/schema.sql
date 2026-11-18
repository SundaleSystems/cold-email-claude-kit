-- ============================================================
-- THE REPLY GATE — full schema, one file by design.
-- To change anything later: edit this file, re-run it in the
-- Supabase SQL Editor. Everything is idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. KNOWLEDGE BASE (offer sheets + one global row)
--    The models may state facts from these rows and NOTHING else.
-- ------------------------------------------------------------
create table if not exists knowledge_base (
  id               uuid primary key default gen_random_uuid(),
  key              text unique not null,          -- 'global' or an offer slug, e.g. 'ai-automation-audit'
  is_global        boolean not null default false,
  offer_name       text,
  original_pitch   text,                          -- EXACT cold email copy, the offer as promised, the CTA
  sender_name      text,
  sender_role      text,
  sender_signoff   text,                          -- appended by code, never written by the model
  offer_facts      text,                          -- what it is / includes / excludes, guarantees, timelines, cleared proof points
  high_level_answer text,                         -- 1-2 sentence description used in "send more info" replies
  pricing_policy   text not null default 'no_price_before_call'
                   check (pricing_policy in ('quote_number','quote_range','no_price_before_call')),
  pricing_facts    text,                          -- the number or range, quoted VERBATIM, only if policy allows quoting
  lead_magnet      text,                          -- the no-strings freebie offered in the price reply
  price_reply      text,                          -- full body override for the price reply; null = use the pricing_facts template
  calendly_url     text,                          -- this offer's booking link (whitelisted in outbound replies)
  common_questions jsonb not null default '[]',   -- [{"q":"...","a":"..."}]
  ideal_replies    jsonb not null default '[]',   -- ["full example reply", ...] — these control wording most
  voice_rules      text,                          -- tone, formatting rules
  max_words        int not null default 120,
  banned_phrases   jsonb not null default '[]',   -- ["circle back","synergy",...]
  business_noun    text,                          -- the ONE correct word: 'firm', 'business', 'practice'...
  timezone         text default 'America/New_York',
  updated_at       timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. CAMPAIGN MAP (which Instantly campaign belongs to which offer)
--    An unmapped campaign is HELD, never answered generically.
--    `live` is the per-campaign go-live switch: even with global
--    shadow mode off, only campaigns with live=true actually send.
-- ------------------------------------------------------------
create table if not exists campaign_map (
  campaign_id   text primary key,                 -- Instantly campaign UUID
  campaign_name text,
  offer_key     text not null references knowledge_base(key),
  live          boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3. REPLIES LOG (every inbound the system touched, what it
--    decided, and why — the full audit trail)
-- ------------------------------------------------------------
create table if not exists replies_log (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  lead_email      text not null,
  lead_first_name text,
  lead_company    text,
  lead_website    text,
  campaign_id     text not null,
  offer_key       text,
  reply_subject   text,
  reply_text      text,
  reply_to_uuid   text,                           -- Instantly email id we reply to
  eaccount        text,                           -- mailbox that ran the campaign (reply goes from here)
  intent          text,
  confidence      numeric,
  draft           text,                           -- model 1 body before code additions
  final_body      text,                           -- what would be / was sent
  checks          jsonb,                          -- deterministic check results
  verifier        jsonb,                          -- verifier verdict, criteria, evidence
  decision        text,                           -- sent | queued | shadow_approved | held | skipped
  decision_reason text,
  status          text not null default 'processing',
                  -- processing | queued | claimed | sent | shadow | held | skipped | error
  send_after      timestamptz,
  sent_at         timestamptz,
  error           text
);

-- One-shot: the system answers the FIRST interested reply per lead
-- per campaign and stays out of the conversation after that.
-- Also makes webhook retries harmless.
create unique index if not exists replies_log_one_shot
  on replies_log (campaign_id, lead_email);

create index if not exists replies_log_due
  on replies_log (status, send_after);

-- ------------------------------------------------------------
-- 4. ATOMIC CLAIM for the send sweep.
--    Two overlapping runs can never send the same email twice.
-- ------------------------------------------------------------
create or replace function claim_due_replies(max_rows int default 10)
returns setof replies_log
language sql
security definer
as $$
  update replies_log
     set status = 'claimed'
   where id in (
     select id from replies_log
      where status = 'queued'
        and send_after <= now()
      order by send_after
      limit max_rows
      for update skip locked
   )
  returning *;
$$;

-- ------------------------------------------------------------
-- 5. LOCK IT DOWN. Only the service role (the edge function)
--    touches these tables. No anon access at all.
-- ------------------------------------------------------------
alter table knowledge_base enable row level security;
alter table campaign_map   enable row level security;
alter table replies_log    enable row level security;
-- (no policies created on purpose: anon/authenticated get nothing;
--  service_role bypasses RLS)

-- ------------------------------------------------------------
-- 6. SEED — global row + one offer sheet template.
--    EDIT THESE IN THE TABLE EDITOR. The placeholders below are
--    deliberately unusable so nothing can send until you write them.
-- ------------------------------------------------------------
insert into knowledge_base (key, is_global, offer_facts, voice_rules)
values (
  'global', true,
  'FILL ME IN: company-wide facts. Who your company is, what it does, where it operates. Only facts you are happy for a prospect to read.',
  'Plain text only. No em-dashes. No markdown. No bullet points. Sound like a busy human, not a newsletter.'
)
on conflict (key) do nothing;

-- The first real offer sheet, built during the 2026-08-25
-- test session. Edit in the table editor as it evolves.
insert into knowledge_base (
  key, is_global, offer_name, original_pitch, sender_name, sender_role,
  sender_signoff, offer_facts, high_level_answer, pricing_policy,
  pricing_facts, lead_magnet, calendly_url,
  common_questions, ideal_replies, voice_rules, max_words,
  banned_phrases, business_noun, timezone
)
values (
  'ai-cold-email-system', false, 'AI Cold Email System',
  E'Hey {{firstName}},\n\nCame across you on LinkedIn. Thought it made sense to reach out.\n\nI install an AI cold email system that books qualified sales calls ~ done-for-you.\n\nNo Risk ~ No setup fee. No long term contracts.\n\nDo you have 10mins to chat about it tmw?\n\nAlex',
  'Alex', 'Founder, Your Company',
  'Alex',
  'Done-for-you AI cold email lead gen system that books qualified sales calls. No setup fee. No long-term contracts. Installed and run for the client.',
  'We build an AI-powered cold email system that identifies your ideal prospects and sends personalized outreach at scale to generate interested replies and sales opportunities.',
  'quote_range',
  '$X-Yk/month (FILL ME IN)',
  '100 ICP-matched leads & 3 copy angles',
  'https://calendly.com/your-name/30min',
  '[]',
  '["Hi Sam,\n\nSounds good. I''ll shoot over a google meet invite for Tuesday 3pm EST.\n\nLook forward to connecting.\n\nAlex"]',
  'Short sentences. Sound like a busy human, not a newsletter. No em-dashes, no markdown, no bullet points.',
  150,
  '["just checking in","circle back","synergy","revolutionize","game-changer"]',
  'business',
  'America/New_York'
)
on conflict (key) do nothing;

-- Idempotence guards for databases created before these columns existed.
alter table knowledge_base add column if not exists high_level_answer text;
alter table knowledge_base add column if not exists lead_magnet text;
alter table knowledge_base add column if not exists calendly_url text;
alter table knowledge_base add column if not exists price_reply text;

-- ------------------------------------------------------------
-- The second offer sheet: Speed to Lead. Built 2026-09-01
-- from the live Instantly campaign copy.
--
-- This offer answers "what does it cost" with "it's free", not with a
-- number — hence price_reply, which replaces the pricing_facts template
-- body. pricing_policy stays no_price_before_call so the deterministic
-- gate hard-fails any dollar figure that finds its way into a draft.
-- ------------------------------------------------------------
insert into knowledge_base (
  key, is_global, offer_name, original_pitch, sender_name, sender_role,
  sender_signoff, offer_facts, high_level_answer, pricing_policy,
  pricing_facts, lead_magnet, price_reply, calendly_url,
  common_questions, ideal_replies, voice_rules, max_words,
  banned_phrases, business_noun, timezone
)
values (
  'speed-to-lead', false, 'Speed to Lead',
  -- All 7 step-1 variants. The prospect received exactly ONE of these,
  -- and the verifier checks every draft against this field — a single
  -- variant here would fail drafts for the other six sevenths of the list.
  -- Merge tags and spintax kept verbatim: this is the exact copy sent.
  E'All 7 variants of the opening email, subject line "inbound leads". This prospect received exactly one of them.\n\n'
  || E'--- Variant A ---\n'
  || E'Hi {{firstName}},\n\nMost automated lead follow up sounds automated.\n\nI built a system that learns how your team talks, then responds to new leads the same way your salespeople would.\n\nIt can reply, follow up, and hand the conversation to your team when needed.\n\nI''ll build yours for free so you can test it.\n\nOpen to a 15min look?\n\n{{accountSignature}}\n\n'
  || E'--- Variant B ---\n'
  || E'Hi {{firstName}},\n\nCurious if you''re losing qualified leads due to slow response times, whether they come in through, lead forms, email, or paid ads.\n\nI help businesses like yours never miss any qualified leads so you can service more clients and generate more revenue.\n\nI just did this for a client in NYC - they were losing qualified leads due to slow response time. I set the system up in less than 7 days, and it helped them close an additional 3 new clients in the first 2 weeks.\n\nI''ll set it up for free. {{RANDOM | You only pay if it gets you more clients. | Try it, let me know if you wanna keep it | See if you like it. | See the results live. | Call you in 7 days to see if you want to keep it. }}\n\n{{accountSignature}}\n\n'
  || E'--- Variant C ---\n'
  || E'Hi {{firstName}},\n\nI''m helping businesses turn more of their inbound leads into actual sales conversations.\n\nNo new ads. No more leads.\n\nJust getting more from the leads you''re already generating.\n\nI''ll build the system for free and let you test it before paying anything.\n\nOpen to a quick look?\n\n{{accountSignature}}\n\n'
  || E'--- Variant D ---\n'
  || E'Hi {{firstName}},\n\nMost businesses don''t have a lead problem.\n\nThey have a follow up problem.\n\nNew leads come in from forms, email, ads, and directories, and someone has to notice them, reply, follow up, and get them to the right salesperson.\n\nI automate that whole process.\n\nOpen to seeing it?\n\n{{accountSignature}}\n\n'
  || E'--- Variant E ---\n'
  || E'Hi {{firstName}},\n\nYou can spend $100+ getting someone to raise their hand, then lose them because nobody replies fast enough.\n\nI built a system that contacts every new lead in under 60 seconds, even when your team is busy.\n\nI''ll set it up free and let you test it.\n\nWorth a 15 min look?\n\n{{accountSignature}}\n\n'
  || E'--- Variant F ---\n'
  || E'Hi {{firstName}},\n\nI built {{RANDOM | an AI system | a system}} that replies to every lead inquiry in under {{RANDOM | 60secs. | 5mins.}}\n\nI''ll build it and install it for you free. Then let me know if you want to keep it.\n\nCan you do a 15 min call to show you how it works?\n\n{{accountSignature}}\n\n'
  || E'--- Variant G ---\n'
  || E'Hi {{firstName}},\n\nI''ll build you a system that responds to every inbound lead in under 60 seconds, follows up automatically, and gets more of the leads you''re already paying for into conversations with your sales team.\n\nI''ll install it for free and run it for 14 days.\n\nIf it doesn''t improve your lead-to-conversation rate, you don''t pay.\n\n{{accountSignature}}',
  'Alex', 'Founder, Your Company',
  'Alex',
  E'Speed to Lead is a done-for-you inbound lead response system. It contacts every new inbound lead in under 60 seconds, across email, text message and phone, follows up automatically until the lead responds, and hands the live conversation to the client''s own salesperson when someone is ready to talk. It works on leads from web forms, email enquiries, paid ads and directories. The system is trained on how the client''s team already talks, so replies sound like their salespeople rather than an autoresponder.\n\n'
  || E'Commercial model: We build and install the full working system for free. The client runs it on their own live leads and then decides whether to keep it. There is no fixed trial length. If they keep it there is an implementation fee plus a monthly fee, both scoped on the call. Never state any fee, number or range in an email reply.\n\n'
  || E'One variant of the cold email offered to install the system free and run it for 14 days, with no payment if it does not improve their lead to conversation rate. If a prospect refers to those terms, they stand. Otherwise there is no fixed trial length.\n\n'
  || E'Cleared proof point (the client is never named): a services business in NYC was losing qualified leads to slow response times. The system was set up in under 7 days and helped them close an additional 3 new clients in the first 2 weeks.\n\n'
  || E'Boundaries: do not promise a setup timeline for this prospect, the under 7 days figure is a past result and not a commitment. Never name any client. Do not state or imply a price. Do not promise a specific number of leads, clients or revenue.',
  'We install a system that answers every new inbound lead in under 60 seconds and keeps following up until they respond, then routes the live conversation to your team. We build it for free so you can test it on your own leads first.',
  'no_price_before_call',
  null,                                    -- no quotable number: the answer to "what does it cost" is "it is free"
  null,                                    -- no lead magnet on this offer; the free build IS the magnet
  E'Great question - it''s completely free. I build and install the whole system for you, you use it on your own leads, and then you decide if you want to keep it.\n\nAre you open to a 15-min call in the next hour? I can show you exactly how it would work for you.',
  'https://calendly.com/your-name/30min',
  '[]',
  '["Hi Sam,\n\nSounds good. I''ll shoot over a google meet invite for Tuesday 3pm EST.\n\nLook forward to connecting.\n\nAlex"]',
  'Short sentences. Sound like a busy human, not a newsletter. No em-dashes, no markdown, no bullet points.',
  150,
  '["just checking in","circle back","synergy","revolutionize","game-changer"]',
  'business',
  'America/New_York'
)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- Campaign mappings. Must come after the knowledge_base inserts:
-- offer_key is a foreign key into that table.
--
-- live=false means shadow: replies are drafted, gated and posted to
-- Slack, but nothing sends until you flip it.
-- ------------------------------------------------------------
insert into campaign_map (campaign_id, campaign_name, offer_key, live)
values ('00000000-0000-0000-0000-000000000000', 'Speed to Lead', 'speed-to-lead', false)
on conflict (campaign_id) do nothing;

-- ------------------------------------------------------------
-- 7. SCHEDULED SENDER — runs the sweep once a minute.
--    Fill in YOUR project ref and YOUR webhook secret, then
--    uncomment and run. (Supabase Dashboard > Integrations
--    can also create this for you.)
-- ------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- select cron.schedule(
--   'reply-gate-send-sweep',
--   '* * * * *',
--   $$
--   select net.http_post(
--     url    := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/reply-gate/send-sweep?secret=YOUR_WEBHOOK_SECRET',
--     headers:= '{"Content-Type":"application/json"}'::jsonb,
--     body   := '{}'::jsonb
--   );
--   $$
-- );

-- To pause the sender entirely:  select cron.unschedule('reply-gate-send-sweep');
