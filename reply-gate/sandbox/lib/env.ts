// Load the workspace .env into Deno.env BEFORE any reply-gate module is
// imported (config.ts throws on a missing secret at import time, which is
// why run.ts imports those modules dynamically).
//
// Hand-rolled parser rather than `source .env`: the file contains
// unquoted values with spaces that a shell chokes on.

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue; // bare continuation lines are ignored
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length > 1) ||
      (val.startsWith("'") && val.endsWith("'") && val.length > 1)
    ) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

/**
 * Populate Deno.env from .env plus harness-only placeholders.
 *
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required by config.ts but
 * only ever read by db.ts, which the sandbox never imports. They get
 * obviously-fake values so a mistake there fails loudly instead of
 * writing to the live replies_log.
 */
export function loadEnv(envPath: string): void {
  let vars: Record<string, string> = {};
  try {
    vars = parseEnvFile(Deno.readTextFileSync(envPath));
  } catch {
    throw new Error(`Could not read ${envPath} — the sandbox needs ANTHROPIC_API_KEY from it.`);
  }

  const placeholders: Record<string, string> = {
    SUPABASE_URL: "https://sandbox.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "sandbox-never-used",
    INSTANTLY_API_KEY: "sandbox-never-used",
    INSTANTLY_WEBHOOK_SECRET: "sandbox-never-used",
    SLACK_BOT_TOKEN: "sandbox-never-used",
    SLACK_ALERT_CHANNEL: "sandbox-never-used",
  };

  for (const [k, v] of Object.entries({ ...placeholders, ...vars })) {
    // Never let the real Supabase/Instantly/Slack write paths be reachable.
    if (k === "SUPABASE_URL" || k === "SUPABASE_SERVICE_ROLE_KEY") continue;
    Deno.env.set(k, v);
  }
  Deno.env.set("SUPABASE_URL", placeholders.SUPABASE_URL);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", placeholders.SUPABASE_SERVICE_ROLE_KEY);

  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    throw new Error(`ANTHROPIC_API_KEY is missing from ${envPath}.`);
  }
}
