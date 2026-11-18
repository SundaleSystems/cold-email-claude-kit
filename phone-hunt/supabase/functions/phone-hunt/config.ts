// Central place for every secret and tunable. All values come from
// Supabase Edge Function secrets (Dashboard > Edge Functions > Secrets).

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required secret: ${name}`);
  return v;
}

const gmailClientId = Deno.env.get("GMAIL_CLIENT_ID") ?? "";
const gmailClientSecret = Deno.env.get("GMAIL_CLIENT_SECRET") ?? "";
const gmailRefreshToken = Deno.env.get("GMAIL_REFRESH_TOKEN") ?? "";

export const config = {
  // --- keys ---
  instantlyApiKey: required("INSTANTLY_API_KEY"),
  slackBotToken: required("SLACK_BOT_TOKEN"),
  slackChannel: required("SLACK_ALERT_CHANNEL"),
  // Separate secret from reply-gate's so either URL can be rotated alone.
  webhookSecret: required("PHONE_HUNT_WEBHOOK_SECRET"),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  apifyToken: required("APIFY_TOKEN"),
  // Optional: without it the LeadMagic source is skipped with a note.
  leadmagicApiKey: Deno.env.get("LEADMAGIC_API_KEY") ?? "",

  // --- email alerts (optional; all three or the channel stays off) ---
  gmailClientId,
  gmailClientSecret,
  gmailRefreshToken,
  gmailEnabled: !!(gmailClientId && gmailClientSecret && gmailRefreshToken),
  alertEmailTo: Deno.env.get("ALERT_EMAIL_TO") ?? "you@yourcompany.com",

  // --- people-search (skip-trace) actor ---
  // one-api/skip-trace: name+location query in, per-phone Type + "last
  // reported" date out. Reliably returns numbers where the fastpeoplesearch
  // / truepeoplesearch actors did not.
  skipTraceActor: Deno.env.get("APIFY_SKIPTRACE_ACTOR") ?? "one-api~skip-trace",
  apifyMaxRecords: parseInt(Deno.env.get("APIFY_MAX_RECORDS") ?? "3", 10),
  apifyMaxChargeUsd: Deno.env.get("APIFY_MAX_CHARGE_USD") ?? "1",
  // 60s per actor: FastPeopleSearch + LeadMagic + signature return well
  // within this; TruePeopleSearch is often slow and just times out
  // (non-fatal) rather than dragging the alert past a minute.
  apifyTimeoutMs: parseInt(Deno.env.get("APIFY_TIMEOUT_MS") ?? "60000", 10),
};
