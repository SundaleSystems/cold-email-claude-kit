#!/usr/bin/env -S deno run -A
// The Reply Gate manual tester.
//
// Opens a page in your browser. Type or paste a reply a prospect might
// send, hit send, and see exactly what the system would say back — run
// through the real classifier, the real templates, the real code checks
// and the real verifier, with your real Calendly slots.
//
// Nothing is sent, nothing is written to replies_log, nothing is posted to
// Slack, and Instantly is never called.
//
//   deno run -A sandbox/serve.ts
//   deno run -A sandbox/serve.ts --port 9000 --no-open
import { loadEnv } from "./lib/env.ts";
import { loadGate, loadSheets, runReply } from "./lib/engine.ts";
import type { CalendarSlots, InboundReply, Lead } from "../supabase/functions/reply-gate/types.ts";

const HERE = decodeURIComponent(new URL(".", import.meta.url).pathname);
const SHEETS_PATH = `${HERE}data/offer-sheets.json`;

const argv = Deno.args;
const portArg = argv.indexOf("--port");
const port = portArg >= 0 ? parseInt(argv[portArg + 1], 10) : 8787;
const autoOpen = !argv.includes("--no-open");

loadEnv(`${HERE}../../.env`);
const { mods, config } = await loadGate();

try {
  loadSheets(SHEETS_PATH);
} catch {
  console.error("No sandbox/data/offer-sheets.json — run:  deno run -A sandbox/pull.ts");
  Deno.exit(1);
}

// ------------------------------------------------------- Calendly cache
// One lookup per 15 minutes: a testing session should not hammer the API,
// and every draft proposing the same two times makes replies comparable.
const SLOT_TTL_MS = 15 * 60_000;
let slotCache: { at: number; slots: CalendarSlots } | null = null;

async function getSlots(timezone: string): Promise<CalendarSlots> {
  if (slotCache && Date.now() - slotCache.at < SLOT_TTL_MS) return slotCache.slots;
  const slots = await mods.getTwoFreeSlots(timezone);
  slotCache = { at: Date.now(), slots };
  return slots;
}

// ---------------------------------------------------------------- routes
async function handleReply(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const text: string = (body.text ?? "").toString();
  if (!text.trim()) return Response.json({ error: "empty reply" }, { status: 400 });

  // Re-read the sheets per request so an edit to offer-sheets.json is
  // picked up without restarting the server.
  const sheets = loadSheets(SHEETS_PATH);
  const offerKey: string = (body.offer ?? sheets.defaultKey).toString();
  const sheet = sheets.byKey.get(offerKey);

  const lead: Lead = {
    email: (body.email ?? "").toString().trim() || "prospect@example.com",
    first_name: (body.first_name ?? "").toString().trim() || undefined,
    company_name: (body.company ?? "").toString().trim() || undefined,
    website: (body.website ?? "").toString().trim() || undefined,
  };
  const reply: InboundReply = {
    id: "manual", subject: (body.subject ?? "Re: quick question").toString(),
    text, eaccount: "sandbox@example.com", campaignId: "manual",
    leadEmail: lead.email, isAutoReply: false,
  };

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const line = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      try {
        const slots = await getSlots(sheet?.timezone ?? "America/New_York");
        const outcome = await runReply(
          { reply, lead, sheet, offerKey, globalFacts: sheets.globalFacts, slots, mods, config },
          (stage) => line({ stage }),
        );
        line({ result: { ...outcome, slotsNote: slots.ok ? slots.slots.join(" / ") : `Calendly unavailable (${slots.error})` } });
      } catch (e) {
        line({ result: { outcome: "error", stage: "server", reason: String(e), ms: 0 } });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}

const FEEDBACK_PATH = `${HERE}out/feedback.jsonl`;

async function handleFeedback(req: Request): Promise<Response> {
  const b = await req.json().catch(() => ({}));
  const verdict = (b.verdict ?? "").toString();
  if (!verdict) return Response.json({ error: "no verdict" }, { status: 400 });

  const entry = {
    at: new Date().toISOString(),
    verdict,                                   // good | wrong_wording | wrong_bucket | should_have_held | should_have_replied
    offer: (b.offer ?? "").toString(),
    prospect_reply: (b.prospect_reply ?? "").toString(),
    lead: b.lead ?? {},
    outcome: (b.outcome ?? "").toString(),     // send | held | skipped | error
    bucket: (b.bucket ?? "").toString(),
    confidence: b.confidence ?? null,
    gate_reason: (b.gate_reason ?? "").toString(),
    produced: (b.produced ?? "").toString(),   // the body the gate built
    ideal: (b.ideal ?? "").toString(),         // what you say it should have said
    note: (b.note ?? "").toString(),
  };
  try {
    await Deno.mkdir(`${HERE}out`, { recursive: true });
    await Deno.writeTextFile(FEEDBACK_PATH, JSON.stringify(entry) + "\n", { append: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
  let count = 0;
  try {
    count = (await Deno.readTextFile(FEEDBACK_PATH)).split("\n").filter((l) => l.trim()).length;
  } catch { /* first write */ }
  return Response.json({ ok: true, count });
}

Deno.serve({ port, onListen: () => {} }, (req) => {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/reply") return handleReply(req);
  // Which offer sheets exist. Re-read per request, like handleReply, so
  // a fresh pull.ts shows up without restarting the server. With more
  // than one offer the picker is the difference between testing the
  // sheet you meant and silently testing whichever came back first.
  if (url.pathname === "/offers") {
    const sheets = loadSheets(SHEETS_PATH);
    const offers = [...sheets.byKey.values()]
      .filter((s) => !s.is_global)
      .map((s) => ({ key: s.key, name: s.offer_name ?? s.key }));
    return Response.json({ offers, defaultKey: sheets.defaultKey });
  }
  // Feedback capture. Appends one JSON line per verdict to
  // sandbox/out/feedback.jsonl — the prospect's reply, the offer, the
  // body the gate produced, and what it SHOULD have said. That last
  // field is the valuable one: ideal_replies drives wording more than
  // any rule, so a corrected reply goes straight onto the offer sheet.
  if (req.method === "POST" && url.pathname === "/feedback") return handleFeedback(req);
  if (url.pathname === "/") {
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response("not found", { status: 404 });
});

const address = `http://localhost:${port}`;
console.log(`\nReply Gate manual tester → ${address}`);
console.log(`models: ${config.draftModel} / ${config.verifyModel} · confidence threshold ${config.confidenceThreshold}`);
console.log(`nothing is sent, logged, or posted to Slack. Ctrl+C to stop.\n`);
if (autoOpen) {
  try { new Deno.Command("open", { args: [address] }).spawn(); } catch { /* not macOS, no matter */ }
}

// ------------------------------------------------------------------ page
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reply Gate &mdash; manual test</title>
<style>
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--line:#e3e5e9;--text:#1a1a1a;--dim:#71757c;--pre:#f6f7f9}
@media(prefers-color-scheme:dark){:root{--bg:#141518;--card:#1e2024;--line:#2e3137;--text:#e8e8e8;--dim:#9aa0a6;--pre:#26282d}}
*{box-sizing:border-box}
body{margin:0;padding:28px 20px 80px;background:var(--bg);color:var(--text);
font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto}
h1{font-size:19px;margin:0 0 4px}
.note{color:var(--dim);font-size:13px;margin:0 0 22px}
.compose{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.lead{display:flex;gap:8px;margin:0 0 12px;flex-wrap:wrap}
.lead input{flex:1 1 150px;min-width:0;padding:8px 10px;border:1px solid var(--line);border-radius:7px;
background:transparent;color:var(--text);font:inherit;font-size:13px}
.toggle{display:inline-flex;gap:0;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.toggle button{padding:7px 14px;border:0;border-radius:0;background:transparent;color:var(--dim);
font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.toggle button + button{border-left:1px solid var(--line)}
.toggle button.on{background:#2f6df5;color:#fff;font-weight:600}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line);font-weight:500}
button.ghost:hover:not(:disabled){color:var(--text);border-color:#4a8cff}
.fb{margin-top:14px;padding-top:13px;border-top:1px dashed var(--line)}
.fbrow{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.vb{padding:5px 11px;border:1px solid var(--line);border-radius:999px;background:transparent;
color:var(--dim);font:inherit;font-size:12px;cursor:pointer}
.vb:hover{color:var(--text);border-color:#4a8cff}
.vb.on{background:#2f6df5;border-color:#2f6df5;color:#fff;font-weight:600}
.ideal{min-height:70px;margin:9px 0;font-size:13px}
.save{padding:6px 13px;font-size:13px}
textarea{width:100%;min-height:120px;padding:11px 12px;border:1px solid var(--line);border-radius:8px;
background:transparent;color:var(--text);font:inherit;resize:vertical}
input:focus,textarea:focus,select:focus{outline:2px solid #4a8cff55;border-color:#4a8cff}
.row{display:flex;align-items:center;gap:12px;margin-top:11px}
button{padding:9px 18px;border:0;border-radius:8px;background:#2f6df5;color:#fff;font:inherit;
font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.hint{color:var(--dim);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-left-width:4px;border-radius:12px;
padding:15px 17px;margin-top:16px}
.card.send{border-left-color:#1a9e4b}.card.held{border-left-color:#d99b00}
.card.skipped{border-left-color:#8b8f96}.card.error{border-left-color:#d3452f}
.card.pending{border-left-color:#2f6df5}
h2{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--dim);margin:0 0 6px;font-weight:600}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--pre);border-radius:8px;padding:11px 13px;
margin:0 0 14px;font:13.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.verdict{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:0 0 10px}
.badge{font-size:11px;font-weight:700;letter-spacing:.05em;padding:3px 9px;border-radius:99px;background:#e9eaee;color:#555}
.send .badge{background:#dff3e6;color:#0f7135}.held .badge{background:#fbeecf;color:#7d5800}
.skipped .badge{background:#e9eaee;color:#5c6067}.error .badge{background:#fadedb;color:#98291a}
@media(prefers-color-scheme:dark){
.badge{background:#33363b;color:#c4c7cc}.send .badge{background:#16351f;color:#6fd894}
.held .badge{background:#3a2f14;color:#e8bf5c}.error .badge{background:#3d1f1a;color:#f09383}}
.bucket{font-size:13px;color:var(--dim)}
.why{font-size:13.5px;background:var(--pre);border-radius:8px;padding:10px 12px;margin:0}
.spin{display:inline-block;width:11px;height:11px;border:2px solid var(--dim);border-top-color:transparent;
border-radius:50%;animation:s .7s linear infinite;vertical-align:-1px;margin-right:7px}
@keyframes s{to{transform:rotate(360deg)}}
</style></head>
<body><main>
<h1>Reply Gate &mdash; manual test</h1>
<p class="note">Real classifier, real templates, real checks, real verifier, real Calendly slots.
Nothing is sent, logged, or posted to Slack. A green WOULD SEND still would not go out in production
today, because SHADOW_MODE is on and the campaign is not live.<br>
Pick the offer with the toggle, or hit <b>Run through both</b> to send the same reply through every
sheet and compare. Each result card is stamped with the offer that produced it.</p>

<div class="compose">
  <div class="lead">
    <input id="first_name" placeholder="First name" autocomplete="off">
    <input id="company" placeholder="Company" autocomplete="off">
    <input id="website" placeholder="Website" autocomplete="off">
  </div>
  <div class="row">
    <span class="hint">Offer</span>
    <div id="offers" class="toggle"></div>
  </div>
  <textarea id="text" placeholder="Paste what the prospect wrote..." autofocus></textarea>
  <div class="row">
    <button id="send">Send reply</button>
    <button id="both" class="ghost">Run through both</button>
    <span class="hint">Cmd+Enter &middot; leave the name blank to test a lead with no first name</span>
  </div>
</div>

<div id="feed"></div>
</main>
<script>
var F = ["first_name","company","website"];
F.forEach(function(k){
  var el = document.getElementById(k);
  var saved = localStorage.getItem("rg_" + k);
  el.value = saved === null ? {first_name:"Sean",company:"Acme Plumbing",website:"acmeplumbing.com"}[k] : saved;
  el.addEventListener("input", function(){ localStorage.setItem("rg_" + k, el.value); });
});

// Offer toggle. One button per sheet; the lit one is what "Send reply"
// uses. With two offers live, a result you cannot attribute to a sheet
// is a result you cannot trust — so the choice is always on screen and
// every result card is stamped with the offer that produced it.
var offersBar = document.getElementById("offers");
var OFFERS = [], current = null;

fetch("/offers").then(function(r){ return r.json(); }).then(function(d){
  OFFERS = d.offers;
  var saved = localStorage.getItem("rg_offer");
  current = (saved && OFFERS.some(function(o){ return o.key === saved; })) ? saved : d.defaultKey;
  OFFERS.forEach(function(o){
    var b = document.createElement("button");
    b.type = "button"; b.dataset.key = o.key; b.textContent = o.name;
    b.title = o.key;
    b.addEventListener("click", function(){ setOffer(o.key); });
    offersBar.appendChild(b);
  });
  paintOffers();
  bothBtn.style.display = OFFERS.length > 1 ? "" : "none";
});

function setOffer(k){
  current = k;
  localStorage.setItem("rg_offer", k);
  paintOffers();
}
function paintOffers(){
  Array.prototype.forEach.call(offersBar.children, function(b){
    b.classList.toggle("on", b.dataset.key === current);
  });
}
function offerName(k){
  for (var i = 0; i < OFFERS.length; i++) if (OFFERS[i].key === k) return OFFERS[i].name;
  return k;
}

var STAGES = {
  classifying: "reading the reply and picking a bucket",
  assembling: "filling in the template",
  checking: "running the deterministic checks",
  verifying: "the verifier is deciding if it is safe to send",
  retrying: "a gate failed, trying once more"
};
var LABEL = { send: "WOULD SEND", held: "HELD", skipped: "SKIPPED", error: "ERROR" };

function esc(s){ return String(s == null ? "" : s).replace(/[&<>]/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); }

var btn = document.getElementById("send");
var bothBtn = document.getElementById("both");
var box = document.getElementById("text");
var feed = document.getElementById("feed");

/** Run one reply through one offer sheet and stream the result into a card. */
async function run(text, offerKey){
  var card = document.createElement("div");
  card.className = "card pending";
  // Stamp the sheet on the card: with two offers, a result you cannot
  // attribute to an offer is a result you cannot trust.
  card.innerHTML = '<h2>They wrote <span class="hint">&middot; ' +
      esc(offerName(offerKey)) + '</span></h2><pre>' + esc(text) + '</pre>' +
    '<div class="verdict"><span class="spin"></span><span class="bucket" id="st">starting</span></div>';
  feed.prepend(card);
  var st = card.querySelector("#st");
  st.removeAttribute("id");

  try{
    var res = await fetch("/reply", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        text: text,
        offer: offerKey,
        first_name: document.getElementById("first_name").value,
        company: document.getElementById("company").value,
        website: document.getElementById("website").value
      })
    });
    var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
    while(true){
      var chunk = await reader.read();
      if(chunk.done) break;
      buf += dec.decode(chunk.value, {stream:true});
      var lines = buf.split("\\n");
      buf = lines.pop();
      lines.forEach(function(l){
        if(!l.trim()) return;
        var msg = JSON.parse(l);
        if(msg.stage) st.textContent = STAGES[msg.stage] || msg.stage;
        if(msg.result) render(card, msg.result, offerKey);
      });
    }
  }catch(e){
    render(card, {outcome:"error", reason:String(e), ms:0}, offerKey);
  }
}

function busy(on){ btn.disabled = on; bothBtn.disabled = on; }

async function send(){
  var text = box.value.trim();
  if(!text || btn.disabled) return;
  busy(true);
  await run(text, current);
  busy(false);
  box.value = "";
  box.focus();
}

/** Same reply, every offer sheet, side by side. The fastest way to see
 *  that the two offers genuinely answer differently. */
async function sendBoth(){
  var text = box.value.trim();
  if(!text || btn.disabled) return;
  busy(true);
  // Sequential, not parallel: the cards then land in a stable order and
  // the two runs cannot interleave their stage updates.
  for (var i = 0; i < OFFERS.length; i++) await run(text, OFFERS[i].key);
  busy(false);
  box.value = "";
  box.focus();
}

function render(card, r, offerKey){
  card.className = "card " + r.outcome;
  var text = card.querySelector("pre").textContent;
  // Keep the offer stamp: render() rebuilds the card, and a result you
  // cannot attribute to a sheet is a result you cannot trust.
  var html = '<h2>They wrote <span class="hint">&middot; ' + esc(offerName(offerKey)) + '</span></h2><pre>' + esc(text) + '</pre>';
  html += '<div class="verdict"><span class="badge">' + LABEL[r.outcome] + '</span>';
  if(r.bucket) html += '<span class="bucket">' + esc(r.bucket) + ' &middot; confidence ' +
    Number(r.confidence).toFixed(2) + (r.retried ? " &middot; after a retry" : "") + '</span>';
  html += '<span class="bucket">' + (r.ms/1000).toFixed(1) + 's</span></div>';
  if(r.draft){
    html += '<h2>' + (r.outcome === "send" ? "It would reply" : "The reply it built (held, would not send)") +
      '</h2><pre>' + esc(r.draft) + '</pre>';
  }
  if(r.reason) html += '<p class="why">' + esc(r.reason) + '</p>';
  card.innerHTML = html;
  addFeedback(card, r, offerKey, text);
}

var VERDICTS = [
  ["good",              "Good"],
  ["wrong_wording",     "Wrong wording"],
  ["wrong_bucket",      "Wrong bucket"],
  ["should_have_held",  "Should have held"],
  ["should_have_replied","Should have replied"]
];

/** One feedback strip per card. Everything needed to act on the note is
 *  captured with it, so nothing has to be reconstructed later. */
function addFeedback(card, r, offerKey, text){
  var wrap = document.createElement("div");
  wrap.className = "fb";
  wrap.innerHTML =
    '<div class="fbrow">' +
      VERDICTS.map(function(v){ return '<button type="button" class="vb" data-v="' + v[0] + '">' + v[1] + '</button>'; }).join("") +
    '</div>' +
    '<textarea class="ideal" placeholder="What should it have said? Paste the reply you would actually send. This is the highest-value field — it goes straight into ideal_replies."></textarea>' +
    '<div class="fbrow"><button type="button" class="save">Save feedback</button><span class="hint fbmsg"></span></div>';
  card.appendChild(wrap);

  var chosen = null;
  var msg = wrap.querySelector(".fbmsg");
  wrap.querySelectorAll(".vb").forEach(function(b){
    b.addEventListener("click", function(){
      chosen = b.dataset.v;
      wrap.querySelectorAll(".vb").forEach(function(x){ x.classList.toggle("on", x === b); });
      // A plain "Good" needs no essay — bank it immediately.
      if(chosen === "good" && !wrap.querySelector(".ideal").value.trim()) save();
    });
  });
  wrap.querySelector(".save").addEventListener("click", save);

  async function save(){
    var ideal = wrap.querySelector(".ideal").value.trim();
    if(!chosen && !ideal){ msg.textContent = "pick a verdict, or write what it should have said"; return; }
    msg.textContent = "saving...";
    try{
      var res = await fetch("/feedback", {
        method:"POST", headers:{"content-type":"application/json"},
        body: JSON.stringify({
          verdict: chosen || (ideal ? "wrong_wording" : ""),
          offer: offerKey, prospect_reply: text,
          lead: {
            first_name: document.getElementById("first_name").value,
            company: document.getElementById("company").value,
            website: document.getElementById("website").value
          },
          outcome: r.outcome, bucket: r.bucket || "", confidence: r.confidence == null ? null : r.confidence,
          gate_reason: r.reason || "", produced: r.draft || "", ideal: ideal
        })
      });
      var d = await res.json();
      msg.textContent = d.ok ? ("saved \\u00b7 " + d.count + " total") : ("error: " + (d.error || "?"));
    }catch(e){ msg.textContent = "error: " + e; }
  }
}

btn.addEventListener("click", send);
bothBtn.addEventListener("click", sendBoth);
box.addEventListener("keydown", function(e){
  if((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
});
</script>
</body></html>`;
