// People-search via the one-api/skip-trace Apify actor.
//
// Input:  { name: ["First Last; City, ST"], max_results: N }
// Output: one record per person, each with flattened Phone-1..Phone-5
//         plus "Phone-N Type" (Wireless/Landline) and "Phone-N Last
//         Reported" ("Last reported Jul 2026"). Extra records come back
//         as "Person Not Found" placeholders.
//
// Two layers of selection (this is the "which one is correct" logic):
//   1. pickPerson  — choose the right human among the results.
//   2. phonesFromPerson — rank that person's numbers: wireless + most
//      recently reported wins; stale numbers are dropped.
import { config } from "./config.ts";
import { digitsOf } from "./score.ts";
import type { LeadKeys, PhoneCandidate, SourceResult } from "./types.ts";

const APIFY = "https://api.apify.com/v2";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "Last reported Jul 2026" → whole months elapsed since then (null if unparseable). */
export function monthsSinceReported(s: string, now = Date.now()): number | null {
  const m = String(s || "").toLowerCase().match(/([a-z]{3})[a-z]*\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[1]];
  if (mon === undefined) return null;
  const then = new Date(Number(m[2]), mon, 1).getTime();
  return Math.max(0, Math.round((now - then) / (1000 * 60 * 60 * 24 * 30.44)));
}

function buildQuery(k: LeadKeys): string {
  const name = `${k.firstName} ${k.lastName}`.replace(/\s+/g, " ").trim();
  if (k.city && k.state) return `${name}; ${k.city}, ${k.state}`;
  if (k.state) return `${name}; ${k.state}`;
  return name;
}

/**
 * Pick the correct person from the actor's records. Drops the empty
 * "Person Not Found" padding, keeps records whose name matches the lead,
 * and prefers the one in the lead's state (else the actor's top-ranked,
 * which is already location-relevant because we pass the city/state).
 */
export function pickPerson(records: any[], k: LeadKeys): any | null {
  const fn = k.firstName.toLowerCase();
  const ln = k.lastName.toLowerCase();
  const real = records.filter((r) =>
    r && typeof r === "object" &&
    String(r["First Name"] ?? "").toLowerCase().trim() !== "person not found" &&
    String(r["First Name"] ?? "").trim() !== "" &&
    r["Phone-1"]
  );
  const named = real.filter((r) =>
    (!fn || String(r["First Name"] ?? "").toLowerCase().includes(fn)) &&
    (!ln || String(r["Last Name"] ?? "").toLowerCase().includes(ln))
  );
  const pool = named.length ? named : [];
  if (!pool.length) return null;
  const stateMatch = k.state
    ? pool.find((r) => String(r["Address Region"] ?? "").toUpperCase() === k.state)
    : undefined;
  return stateMatch ?? pool[0];
}

/**
 * Rank a person's phones. Wireless (mobile) scores above landline
 * (office); a recently reported number scores above a stale one. Keep
 * numbers reported within ~36 months; if none are that fresh, keep only
 * the single most-recent one (so we always surface the best available).
 */
export function phonesFromPerson(
  person: any,
  companyDigits: string,
  now = Date.now(),
): PhoneCandidate[] {
  const rated: { c: PhoneCandidate; months: number }[] = [];
  for (let i = 1; i <= 5; i++) {
    const raw = person[`Phone-${i}`];
    if (!raw) continue;
    const digits = digitsOf(raw);
    if (digits.length !== 10 || (companyDigits && digits === companyDigits)) continue;

    const type = String(person[`Phone-${i} Type`] ?? "").toLowerCase();
    const isWireless = /wireless|mobile|cell/.test(type);
    const reportedRaw = String(
      person[`Phone-${i} Last Reported`] ?? person[`Phone-${i} First Reported`] ?? "",
    );
    const months = monthsSinceReported(reportedRaw, now) ?? 999;
    const reported = reportedRaw.replace(/^\s*last reported\s*/i, "").trim() || "date unknown";
    const provider = String(person[`Phone-${i} Provider`] ?? "").trim();

    const score = isWireless
      ? (months <= 18 ? 85 : months <= 36 ? 75 : 58)
      : (months <= 18 ? 55 : months <= 36 ? 48 : 40);

    rated.push({
      months,
      c: {
        digits,
        score,
        type: isWireless ? "mobile" : "office",
        source: "SkipTrace",
        note: `${isWireless ? "wireless" : "landline"}, reported ${reported}${provider ? ` (${provider})` : ""}`,
      },
    });
  }
  if (!rated.length) return [];
  const fresh = rated.filter((r) => r.months <= 36);
  const chosen = fresh.length ? fresh : [rated.sort((a, b) => a.months - b.months)[0]];
  return chosen.map((r) => r.c);
}

/**
 * Run skip-trace for this lead. Needs at least a state (a bare name with
 * no location can't be disambiguated safely). Every failure mode returns
 * an empty candidate list + a status string — the hunt continues on the
 * other sources.
 */
export async function runSkipTrace(k: LeadKeys): Promise<SourceResult> {
  if (!k.state && !k.city) return { candidates: [], status: "skipped:no-location" };

  const companyDigits = digitsOf(k.companyPhone);
  const qs = new URLSearchParams({
    token: config.apifyToken,
    timeout: String(Math.floor(config.apifyTimeoutMs / 1000) - 5),
    maxTotalChargeUsd: config.apifyMaxChargeUsd,
  });
  const url = `${APIFY}/acts/${config.skipTraceActor}/run-sync-get-dataset-items?${qs}`;

  let items: any[];
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: [buildQuery(k)], max_results: config.apifyMaxRecords }),
      signal: AbortSignal.timeout(config.apifyTimeoutMs),
    });
    if (!res.ok) return { candidates: [], status: `http:${res.status}` };
    items = await res.json();
    if (!Array.isArray(items)) items = [];
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    return { candidates: [], status: timedOut ? "timeout" : "error" };
  }

  const person = pickPerson(items, k);
  if (!person) return { candidates: [], status: "ok:0" };
  const candidates = phonesFromPerson(person, companyDigits);
  return { candidates, status: `ok:${candidates.length}` };
}
