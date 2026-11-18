#!/usr/bin/env -S deno run -A
// The Reply Gate sandbox, batch mode.
//
// Runs a whole file of hypothetical prospect replies through the REAL
// classifier, templates, deterministic checks and verifier, and reports
// what the system would have said to each one. For sending replies one at
// a time and reading the answer, use the manual tester instead:
//
//   deno run -A sandbox/serve.ts
//
// What is real:   noise filter, quote stripping, scheduling-link rule,
//                 classifier (Claude), template assembly, code checks,
//                 verifier (Claude), retry logic, Calendly slots.
// What is faked:  the Instantly reply/lead lookup (comes from your case
//                 file), the offer sheet (read from data/offer-sheets.json,
//                 pulled from Supabase by pull.ts), and the campaign_map.
// What NEVER happens: no email is sent, no replies_log row is written,
//                 no Slack message is posted, no Instantly call is made.
//
// Usage:
//   deno run -A sandbox/run.ts                        # run cases/default.md
//   deno run -A sandbox/run.ts --cases cases/mine.md
//   deno run -A sandbox/run.ts --only price           # filter by case name
//   deno run -A sandbox/run.ts --reply "how much?"    # one ad-hoc reply
//   deno run -A sandbox/run.ts --fake-slots           # skip Calendly, fixed times
import { loadEnv } from "./lib/env.ts";
import { parseCases, type TestCase } from "./lib/cases.ts";
import { loadGate, loadSheets, runReply, type SheetBundle } from "./lib/engine.ts";
import {
  type CaseResult, renderConsole, renderHtml, renderMarkdown, renderSummary,
} from "./lib/report.ts";
import type { CalendarSlots, InboundReply, Lead } from "../supabase/functions/reply-gate/types.ts";

// decodeURIComponent: the workspace path contains spaces, which arrive
// percent-encoded in a file:// URL.
const HERE = decodeURIComponent(new URL(".", import.meta.url).pathname);

// ---------------------------------------------------------------- args
const args = Deno.args;
const flag = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name: string) => args.includes(`--${name}`);

const casesFile = flag("cases", "cases/default.md")!;
const only = flag("only");
const adHoc = flag("reply");
const fakeSlots = has("fake-slots");
const concurrency = parseInt(flag("concurrency", "4")!, 10);

// ------------------------------------------------- env, then real code
loadEnv(`${HERE}../../.env`);
const { mods, config } = await loadGate();

// ------------------------------------------------------- offer sheets
let sheets: SheetBundle;
try {
  sheets = loadSheets(`${HERE}data/offer-sheets.json`);
} catch {
  console.error("No sandbox/data/offer-sheets.json — run:  deno run -A sandbox/pull.ts");
  Deno.exit(1);
}

// -------------------------------------------------------------- cases
let cases: TestCase[];
if (adHoc) {
  cases = parseCases(`## ad-hoc reply\n@first_name: Sam\n@company: Northwind Plumbing\n@website: northwindplumbing.com\n\n${adHoc}`, sheets.defaultKey);
} else {
  const path = casesFile.startsWith("/") ? casesFile : `${HERE}${casesFile.replace(/^sandbox\//, "")}`;
  cases = parseCases(Deno.readTextFileSync(path), sheets.defaultKey);
}
if (only) {
  const needle = only.toLowerCase();
  cases = cases.filter((c) => c.name.toLowerCase().includes(needle));
  if (cases.length === 0) { console.error(`No case name contains "${only}".`); Deno.exit(1); }
}

// -------------------------------------------------------------- slots
// One Calendly lookup for the whole run, reused by every case, so the
// sandbox does not hammer the API and every draft proposes the same times.
const FAKE: CalendarSlots = { ok: true, slots: ["Tuesday at 11:00 AM EDT", "Wednesday at 2:00 PM EDT"] };
let slots: CalendarSlots;
let slotsNote: string;
if (fakeSlots) {
  slots = FAKE;
  slotsNote = "fixed test slots (--fake-slots)";
} else {
  slots = await mods.getTwoFreeSlots(sheets.byKey.get(cases[0].offer)?.timezone ?? "America/New_York");
  slotsNote = slots.ok
    ? `live Calendly slots: ${slots.slots.join(" / ")}`
    : `Calendly lookup failed (${slots.error}) — drafts degrade to asking availability`;
}

// ------------------------------------------------------------ one case
async function runCase(t: TestCase): Promise<CaseResult> {
  const reply: InboundReply = {
    id: "sandbox", subject: t.subject, text: t.body,
    eaccount: "sandbox@example.com", campaignId: "sandbox",
    leadEmail: t.email, isAutoReply: t.isAutoReply,
  };
  const lead: Lead = {
    email: t.email, first_name: t.first_name, last_name: t.last_name,
    company_name: t.company_name, website: t.website,
  };
  const outcome = await runReply({
    reply, lead, sheet: sheets.byKey.get(t.offer), offerKey: t.offer,
    globalFacts: sheets.globalFacts, slots, mods, config,
  });
  return { ...outcome, testCase: t };
}

// ------------------------------------------------------------- driver
console.log(`\nReply Gate sandbox — ${cases.length} case${cases.length === 1 ? "" : "s"}`);
console.log(`offer sheets: ${sheets.pulledFrom} · models: ${config.draftModel} / ${config.verifyModel} · threshold ${config.confidenceThreshold}`);
console.log(slotsNote);
console.log("nothing is sent, logged, or posted to Slack\n");

const results: CaseResult[] = new Array(cases.length);
let next = 0;
let finished = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= cases.length) return;
      results[i] = await runCase(cases[i]);
      finished++;
      Deno.stderr.writeSync(new TextEncoder().encode(`\r  ${finished}/${cases.length} done`));
    }
  }),
);
Deno.stderr.writeSync(new TextEncoder().encode("\r" + " ".repeat(30) + "\r"));

for (const r of results) console.log(renderConsole(r));
console.log(renderSummary(results));

const when = new Date().toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET";
await Deno.mkdir(`${HERE}out`, { recursive: true });
Deno.writeTextFileSync(`${HERE}out/report.md`, renderMarkdown(results, { when, slotsNote }));
Deno.writeTextFileSync(`${HERE}out/report.html`, renderHtml(results, { when, slotsNote }));
console.log(`  reports: sandbox/out/report.html  ·  sandbox/out/report.md`);
console.log(`  open with: open reply-gate/sandbox/out/report.html\n`);
