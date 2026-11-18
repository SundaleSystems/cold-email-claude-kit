// Central place for every secret and tunable. All values come from
// Supabase Edge Function secrets (Dashboard > Edge Functions > Secrets).

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required secret: ${name}`);
  return v;
}

export const config = {
  // --- keys ---
  instantlyApiKey: required("INSTANTLY_API_KEY"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  calendlyApiKey: Deno.env.get("CALENDLY_API_KEY") ?? "",
  slackBotToken: required("SLACK_BOT_TOKEN"),
  slackChannel: required("SLACK_ALERT_CHANNEL"),
  webhookSecret: required("INSTANTLY_WEBHOOK_SECRET"),
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),

  // --- behavior ---
  // SHADOW_MODE=true: everything runs for real except the send.
  // Flip to "false" only after the shadow period. Takes effect on the
  // next reply, no redeploy.
  shadowMode: (Deno.env.get("SHADOW_MODE") ?? "true").toLowerCase() !== "false",
  confidenceThreshold: parseFloat(Deno.env.get("CONFIDENCE_THRESHOLD") ?? "0.8"),
  sendDelayMinutes: parseInt(Deno.env.get("SEND_DELAY_MINUTES") ?? "4", 10),

  // --- models (change twice a year, so they live here, not in a table) ---
  draftModel: Deno.env.get("DRAFT_MODEL") ?? "claude-sonnet-5",
  verifyModel: Deno.env.get("VERIFY_MODEL") ?? "claude-sonnet-5",

  // --- calendly ---
  // Optional: the event type slug to pull slots from. If unset, the
  // first active event type on the account is used.
  calendlyEventTypeSlug: Deno.env.get("CALENDLY_EVENT_TYPE_SLUG") ?? "",
};
