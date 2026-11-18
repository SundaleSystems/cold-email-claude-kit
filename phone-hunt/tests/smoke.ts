// Smoke tests for the deterministic layers (no network, no secrets).
// Run: deno run tests/smoke.ts   (config.ts is never imported here, so no
// env vars are needed — these modules are all pure.)
import { parseSignature, cutQuotedHistory, stripHtml } from "../supabase/functions/phone-hunt/signature.ts";
import { parseLocation } from "../supabase/functions/phone-hunt/location.ts";
import {
  candidatesFromSignature,
  digitsOf,
  pretty,
  scoreAndSort,
} from "../supabase/functions/phone-hunt/score.ts";
import { emailHtml, emailSubject, slackMessage } from "../supabase/functions/phone-hunt/notify.ts";
import type { LeadKeys, PhoneCandidate } from "../supabase/functions/phone-hunt/types.ts";

let failures = 0;
function t(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

// --- signature parsing ---
const sigMobile = parseSignature("Sounds great.\n\nJane Doe\nM: (512) 555-1234\nAcme Corp", "", "");
t("labeled mobile → mobile", sigMobile.length === 1 && sigMobile[0].type === "mobile" && sigMobile[0].digits === "5125551234");

const sigOffice = parseSignature("Best,\nJohn\nDirect: 415-555-9876", "", "");
t("labeled direct → office", sigOffice.length === 1 && sigOffice[0].type === "office");

const sigFax = parseSignature("Regards\nFax: 212-555-0000\nCell: 212-555-1111", "", "");
t("fax discarded, cell kept", sigFax.length === 1 && sigFax[0].digits === "2125551111" && sigFax[0].type === "mobile");

const sigUnknown = parseSignature("Reach me at 646-555-2020", "", "");
t("unlabeled → unknown", sigUnknown.length === 1 && sigUnknown[0].type === "unknown");

const sigCompany = parseSignature("Office 800-555-4444\nCell 800-555-7777", "", "800-555-4444");
t("company switchboard dropped", sigCompany.length === 1 && sigCompany[0].digits === "8005557777");

const sigDedupe = parseSignature("Call 512-555-1234 or (512) 555-1234", "", "");
t("dupe number within signature collapsed", sigDedupe.length === 1);

const sigFormats = parseSignature("m: +1 (212) 555-3000 · alt 212.555.4000", "", "");
t("+1/parens/dots formats both matched", sigFormats.length === 2);

// --- quoted-history cut ---
const quoted = "Yes let's talk. Here's my cell 512-555-1234.\n\nOn Mon, Aug 24, 2026 at 9am Alex <z@s.com> wrote:\n> reach me at 999-555-0000";
t("quoted history cut before our own number", cutQuotedHistory(quoted).includes("512-555-1234") && !cutQuotedHistory(quoted).includes("999-555-0000"));
const quotedSig = parseSignature(quoted, "", "");
t("signature parse ignores quoted number", quotedSig.length === 1 && quotedSig[0].digits === "5125551234");

// bottom-of-reply signature below the quote (Gmail/Apple Mail layout, like Jane's)
const bottomSig = "no\n\nOn Thu, Jul 16, 2026 at 9:38 AM Alex Rivera <\nz@s.com> wrote:\n> Jane, I will keep this short.\n> reach me at 999-555-0000\n>\n-- \nJane Sample, LCSW\nExecutive Director\n(516) 555-0192 ext. 21\nwww.example.com";
const bottomParsed = parseSignature(bottomSig, "", "");
t("bottom-of-reply signature IS captured", bottomParsed.some((n) => n.digits === "5165550192"));
t("our quoted number still dropped", !bottomParsed.some((n) => n.digits === "9995550000"));

// Outlook top-post: signature above a From:/Sent: quote block
const outlook = "Sounds good.\nJane Doe\nCell: 212-555-7000\n\nFrom: Alex <z@s.com>\nSent: Monday\n> old thread 999-555-1111";
const outlookParsed = parseSignature(outlook, "", "");
t("Outlook top-post signature captured, quote dropped", outlookParsed.some((n) => n.digits === "2125557000") && !outlookParsed.some((n) => n.digits === "9995551111"));

// --- HTML-only reply ---
const htmlReply = parseSignature("", "<p>Sounds good.</p><br>Cell: <b>(303) 555-8080</b>", "");
t("HTML reply parsed after strip", htmlReply.length === 1 && htmlReply[0].digits === "3035558080");
t("stripHtml collapses tags", !stripHtml("<p>hi<br>there</p>").includes("<"));

// --- extension capture ---
const extClean = parseSignature("Office: (212) 555-1234 ext. 21", "", "");
t("ext. captured (clean)", extClean.length === 1 && extClean[0].ext === "21");
const extX = parseSignature("Direct 415-555-9876 x300", "", "");
t("x-style extension captured", extX[0].ext === "300");
const extGarbled = parseSignature("[image: icon] (516) 555-0192 ext.  <(516)555-0192ext.31>21", "", "");
t("garbled bracketed-URL ext still captured as 21", extGarbled.length === 1 && extGarbled[0].digits === "5165550192" && extGarbled[0].ext === "21");
const noExt = parseSignature("Reach me at 646-555-2020 today", "", "");
t("no extension → undefined (not a false grab)", noExt[0].ext === undefined);
const extScored = scoreAndSort(candidatesFromSignature(parseSignature("Direct: (516) 555-0192 ext. 21", "", "")));
const extSlack = slackMessage(
  { eventType: "", campaignId: "c", campaignName: "x", firstName: "Jane", lastName: "Sample", email: "d@x.com", companyName: "Acme", industry: "", locationRaw: "", city: null, state: null, linkedinUrl: "", companyPhone: "", replyText: "" },
  extScored,
  { signature: "ok:1" },
);
t("extension shown in the Slack alert", extSlack.includes("555-0192 ext. 21"));

// --- location parsing ---
t("City, State full name", JSON.stringify(parseLocation("Austin, Texas")) === JSON.stringify({ city: "Austin", state: "TX" }));
t("metro area", JSON.stringify(parseLocation("Los Angeles Metropolitan Area")) === JSON.stringify({ city: "Los Angeles", state: "CA" }));
t("bay area metro", parseLocation("San Francisco Bay Area").state === "CA");
t("bare state abbrev", JSON.stringify(parseLocation("TX")) === JSON.stringify({ city: null, state: "TX" }));
t("non-US → no state (gate closed)", parseLocation("Toronto, Ontario").state === null);
t("United States suffix stripped", parseLocation("Denver, Colorado, United States").state === "CO");
t("empty string safe", parseLocation("").state === null);

// --- scoring & dedupe ---
t("digitsOf strips country code", digitsOf("+1 (512) 555-1234") === "5125551234");
t("pretty formats", pretty("5125551234") === "+1 (512) 555-1234");

const single = scoreAndSort(candidatesFromSignature([{ digits: "5125551234", type: "mobile", label: "labeled mobile/cell" }]));
t("signature-mobile scores 95", single.mobiles[0].score === 95);

const corroborated: PhoneCandidate[] = [
  { digits: "5125551234", score: 95, type: "mobile", source: "email signature", note: "labeled mobile/cell" },
  { digits: "5125551234", score: 90, type: "mobile", source: "LeadMagic", note: "B2B mobile-finder" },
];
const merged = scoreAndSort(corroborated);
t("two sources → single deduped number", merged.mobiles.length === 1);
t("corroboration bonus caps at 99", merged.mobiles[0].score === 99);
t("corroboration note + sourceList", merged.mobiles[0].sourceList.includes("+") && merged.mobiles[0].note.includes("corroborated"));

const mixed = scoreAndSort([
  { digits: "5125550001", score: 95, type: "mobile", source: "email signature", note: "m" },
  { digits: "5125550002", score: 40, type: "office", source: "email signature", note: "o" },
]);
t("office sorted into 'others'", mixed.mobiles.length === 1 && mixed.others.length === 1 && mixed.others[0].type === "office");

const peopleSearch = scoreAndSort([
  { digits: "5125550003", score: 75, type: "unknown", source: "FastPeopleSearch", note: "Austin, TX match, primary listing" },
]);
t("people-search city-match base 75, lands in mobiles bucket", peopleSearch.mobiles[0].score === 75);

// --- skip-trace people-search selection logic ---
import { monthsSinceReported, phonesFromPerson, pickPerson } from "../supabase/functions/phone-hunt/apify.ts";
const NOW = new Date(2026, 7, 15).getTime(); // Aug 2026, fixed for determinism
const janeRec: Record<string, unknown> = {
  "First Name": "Jane", "Last Name": "Sample", "Age": "56", "Address Region": "NY", "Address Locality": "Lynbrook",
  "Phone-1": "(516) 555-0196", "Phone-1 Type": "Wireless", "Phone-1 Last Reported": "Last reported Jul 2026", "Phone-1 Provider": "AT&T",
  "Phone-2": "(516) 555-0169", "Phone-2 Type": "Landline", "Phone-2 Last Reported": "Last reported Jul 2021",
  "Phone-5": "(301) 555-0146", "Phone-5 Type": "Landline", "Phone-5 Last Reported": "Last reported Mar 2016",
};
const notFound = { "First Name": "Person Not Found", "Last Name": "" };
const kJane: LeadKeys = {
  eventType: "reply_interested", campaignId: "c", campaignName: "x",
  firstName: "Jane", lastName: "Sample", email: "d@x.com", companyName: "Acme",
  industry: "", locationRaw: "Westbury, NY", city: "Westbury", state: "NY",
  linkedinUrl: "", companyPhone: "", replyText: "",
};

t("monthsSinceReported recent ~1mo", monthsSinceReported("Last reported Jul 2026", NOW) === 1);
t("monthsSinceReported old ~125mo", (monthsSinceReported("Last reported Mar 2016", NOW) ?? 0) > 100);
t("monthsSinceReported unparseable → null", monthsSinceReported("who knows", NOW) === null);

t("pickPerson skips 'Person Not Found' placeholders", pickPerson([notFound, notFound, janeRec], kJane) === janeRec);
t("pickPerson returns null when no real match", pickPerson([notFound, notFound], kJane) === null);
t("pickPerson filters wrong name", pickPerson([{ "First Name": "Bob", "Last Name": "Jones", "Phone-1": "x", "Address Region": "NY" }], kJane) === null);

const denaPhones = phonesFromPerson(janeRec, "", NOW);
t("phonesFromPerson keeps only the fresh wireless number", denaPhones.length === 1 && denaPhones[0].digits === "5165550196");
t("fresh wireless scored 85 / mobile", denaPhones[0].score === 85 && denaPhones[0].type === "mobile");
t("phonesFromPerson drops the company switchboard", !phonesFromPerson(janeRec, "5165550196", NOW).some((p) => p.digits === "5165550196"));

// --- alert formatting ---
const k: LeadKeys = {
  eventType: "reply_interested", campaignId: "c1", campaignName: "lfg - best cmp",
  firstName: "Jane", lastName: "Doe", email: "jane@acme.com", companyName: "Acme Corp",
  industry: "SaaS", locationRaw: "Austin, Texas", city: "Austin", state: "TX",
  linkedinUrl: "", companyPhone: "", replyText: "",
};
const status = { signature: "ok:1", fps: "ok:1", tps: "timeout", leadmagic: "ok:1" };
const slack = slackMessage(k, merged, status);
t("slack alert has name + company", slack.includes("Jane Doe") && slack.includes("Acme Corp"));
t("slack alert has number + score", slack.includes("+1 (512) 555-1234") && slack.includes("99%"));
t("slack alert has source status footer", slack.includes("tps timeout"));

const zero = scoreAndSort([]);
const slackZero = slackMessage(k, zero, status);
t("zero-results slack alert still names the lead", slackZero.includes("Jane Doe") && slackZero.toLowerCase().includes("no phone numbers found"));

const html = emailHtml(k, merged, status);
t("email html has number", html.includes("+1 (512) 555-1234"));
t("email subject names lead", emailSubject(k) === "New Lead: Jane Doe phone number");
t("email escapes html-unsafe company", emailHtml({ ...k, companyName: "A&B <Co>" }, zero, status).includes("A&amp;B &lt;Co&gt;"));

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
if (failures > 0) Deno.exit(1);
