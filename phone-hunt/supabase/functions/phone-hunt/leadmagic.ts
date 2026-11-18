// LeadMagic B2B mobile-finder. One call per lead: work email in, mobile
// number out. 5 credits on a hit, free on a miss, HTTP 402 when the
// credit pool is empty (surfaced as a distinct note so a silent
// exhaustion still shows up in the alert footer).
//
// DEPLOY-TIME CHECK: path is /v1/people/mobile-finder per the n8n
// template. Other repo scripts hit unversioned root paths
// (api.leadmagic.io/email-finder), so a 404 here means "wrong path" —
// the status note calls that out.
import { config } from "./config.ts";
import { digitsOf } from "./score.ts";
import type { LeadKeys, SourceResult } from "./types.ts";

const ENDPOINT = "https://api.leadmagic.io/v1/people/mobile-finder";

export async function findMobile(k: LeadKeys): Promise<SourceResult> {
  if (!config.leadmagicApiKey) {
    return { candidates: [], status: "skipped:no-key" };
  }

  const body: Record<string, string> = { work_email: k.email };
  if (k.linkedinUrl) body.profile_url = k.linkedinUrl;

  let data: any;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "X-API-Key": config.leadmagicApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 402) return { candidates: [], status: "http:402 (out of credits)" };
    if (res.status === 404) return { candidates: [], status: "http:404 (check endpoint path)" };
    if (!res.ok) return { candidates: [], status: `http:${res.status}` };
    data = await res.json();
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    return { candidates: [], status: timedOut ? "timeout" : "error" };
  }

  const d = digitsOf(data?.mobile_number);
  if (d.length !== 10) return { candidates: [], status: "ok:0" };
  return {
    candidates: [{ digits: d, score: 90, type: "mobile", source: "LeadMagic", note: "B2B mobile-finder" }],
    status: "ok:1",
  };
}
