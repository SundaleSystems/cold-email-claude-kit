// SPEED TO CALL — single Supabase Edge Function, one route:
//
//   POST /phone-hunt?secret=...   ← Instantly "lead marked as interested" webhook
//
// The moment a lead turns positive, hunt down their mobile number
// (signature → FastPeopleSearch → TruePeopleSearch → LeadMagic) and
// alert you so the call happens inside 5 minutes.
//
// Unlike reply-gate there is no cron sweep and no delayed send — one
// single pass, alert out in under ~90 seconds.
//
// The webhook answers immediately and does the slow work in the
// background — sending platforms retry anything that responds slowly,
// and retries mean duplicate alerts.
//
// Deploy (note --no-verify-jwt: Instantly cannot sign a Supabase JWT;
// our own secret in the URL is the auth):
//   supabase functions deploy phone-hunt --no-verify-jwt
import { config } from "./config.ts";
import { runPhoneHunt } from "./pipeline.ts";

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

  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Answer now, hunt in the background.
  // @ts-ignore EdgeRuntime is provided by the Supabase edge environment
  EdgeRuntime.waitUntil(runPhoneHunt(payload));

  return Response.json({ ok: true });
});
