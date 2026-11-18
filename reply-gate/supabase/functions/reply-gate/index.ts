// THE REPLY GATE — single Supabase Edge Function, two routes:
//
//   POST /reply-gate?secret=...             ← Instantly "lead interested" webhook
//   POST /reply-gate/send-sweep?secret=...  ← pg_cron, once a minute
//
// One program to deploy, one place to look when something misbehaves.
//
// The webhook answers immediately and does the slow work in the
// background — sending platforms retry anything that responds slowly,
// and retries mean duplicate replies.
//
// Deploy (note --no-verify-jwt: Instantly cannot sign a Supabase JWT;
// our own secret in the URL is the auth):
//   supabase functions deploy reply-gate --no-verify-jwt
import { config } from "./config.ts";
import { processInterestedLead } from "./pipeline.ts";
import { runSendSweep } from "./sender.ts";

// Constant-time-ish comparison; good enough for a URL secret.
function secretOk(url: URL): boolean {
  const given = url.searchParams.get("secret") ?? "";
  if (given.length !== config.webhookSecret.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ config.webhookSecret.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (!secretOk(url)) {
    return new Response("forbidden", { status: 403 });
  }

  // Route 2: the once-a-minute send sweep
  if (url.pathname.endsWith("/send-sweep")) {
    const result = await runSendSweep();
    return Response.json(result);
  }

  // Route 1: the Instantly webhook
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Answer now, think later.
  // @ts-ignore EdgeRuntime is provided by the Supabase edge environment
  EdgeRuntime.waitUntil(processInterestedLead(payload));

  return Response.json({ ok: true });
});
