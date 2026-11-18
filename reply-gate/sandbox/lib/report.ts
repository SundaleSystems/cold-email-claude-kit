// Console + markdown + HTML rendering of a sandbox run.
import type { TestCase } from "./cases.ts";
import type { Outcome, ReplyOutcome } from "./engine.ts";

export type { Outcome };

/** One engine outcome plus the case that produced it. */
export type CaseResult = ReplyOutcome & { testCase: TestCase };

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  blue: "\x1b[36m", grey: "\x1b[90m",
};

const BADGE: Record<Outcome, string> = {
  send: `${C.green}${C.bold} WOULD SEND ${C.reset}`,
  held: `${C.yellow}${C.bold}   HELD     ${C.reset}`,
  skipped: `${C.grey}${C.bold}  SKIPPED   ${C.reset}`,
  error: `${C.red}${C.bold}   ERROR    ${C.reset}`,
};

const PLAIN: Record<Outcome, string> = {
  send: "WOULD SEND", held: "HELD", skipped: "SKIPPED", error: "ERROR",
};

function expectedOutcome(expect?: string): Outcome | null {
  if (!expect) return null;
  if (expect === "skipped") return "skipped";
  if (expect === "held") return "held";
  return ["positive_interested", "positive_price", "positive_soft_info", "positive_soft_later", "positive_referral"]
    .includes(expect) ? "send" : "held";
}

/** Did the run match what the case said it expected? null = no expectation. */
export function matchesExpectation(r: CaseResult): boolean | null {
  const e = r.testCase.expect;
  if (!e) return null;
  const wantOutcome = expectedOutcome(e);
  if (r.outcome !== wantOutcome) return false;
  // For bucket-level expectations also require the bucket to match, except
  // for the catch-all "held"/"skipped" expectations.
  if (e !== "held" && e !== "skipped" && r.bucket !== e) return false;
  return true;
}

export function renderConsole(r: CaseResult): string {
  const t = r.testCase;
  const out: string[] = [];
  const match = matchesExpectation(r);
  const expectTag = t.expect
    ? ` ${match ? C.green + "✓" : C.red + "✗ expected " + t.expect}${C.reset}`
    : "";

  out.push("");
  out.push(`${C.grey}${"─".repeat(78)}${C.reset}`);
  out.push(`${BADGE[r.outcome]} ${C.bold}${t.name}${C.reset}${expectTag}`);
  const who = [t.first_name, t.company_name].filter(Boolean).join(" @ ") || t.email;
  out.push(`${C.grey}${who} · ${t.email} · ${(r.ms / 1000).toFixed(1)}s${r.retried ? " · retried" : ""}${C.reset}`);
  out.push("");
  out.push(`${C.blue}THEY WROTE:${C.reset}`);
  out.push(indent(t.body, "  "));

  if (r.bucket) {
    out.push("");
    out.push(`${C.blue}CLASSIFIED:${C.reset} ${r.bucket} @ ${r.confidence?.toFixed(2)}`);
    if (r.reasoning) out.push(`${C.grey}${indent(wrap(r.reasoning, 74), "  ")}${C.reset}`);
  }

  if (r.draft) {
    out.push("");
    out.push(`${C.blue}${r.outcome === "send" ? "WE WOULD REPLY:" : "DRAFT (not sent):"}${C.reset}`);
    out.push(indent(r.draft, "  "));
  }

  if (r.checkFailures?.length) {
    out.push("");
    out.push(`${C.red}CODE CHECKS FAILED:${C.reset} ${r.checkFailures.join("; ")}`);
  }

  if (r.verifier) {
    const line = Object.entries(r.verifier.criteria)
      .map(([k, v]) => `${v?.pass ? C.green + "✓" : C.red + "✗"} ${k}${C.reset}`).join("  ");
    out.push("");
    out.push(`${C.blue}VERIFIER:${C.reset} ${line}`);
    if (!r.verifier.overall_pass) {
      const failed = Object.entries(r.verifier.criteria).filter(([, v]) => !v?.pass);
      for (const [k, v] of failed) out.push(`${C.grey}${indent(wrap(`${k}: ${v.evidence}`, 74), "  ")}${C.reset}`);
    }
  }

  if (r.reason) {
    out.push("");
    out.push(`${C.yellow}WHY${C.reset} ${indent(wrap(r.reason, 74), "  ").trimStart()}`);
  }

  return out.join("\n");
}

export function renderSummary(results: CaseResult[]): string {
  const counts = { send: 0, held: 0, skipped: 0, error: 0 };
  let checked = 0, matched = 0;
  for (const r of results) {
    counts[r.outcome]++;
    const m = matchesExpectation(r);
    if (m !== null) { checked++; if (m) matched++; }
  }
  const rows = results.map((r) => {
    const m = matchesExpectation(r);
    const flag = m === null ? " " : m ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    const badge = { send: `${C.green}send   ${C.reset}`, held: `${C.yellow}held   ${C.reset}`, skipped: `${C.grey}skipped${C.reset}`, error: `${C.red}error  ${C.reset}` }[r.outcome];
    return `  ${flag} ${badge}  ${(r.bucket ?? "-").padEnd(20)} ${r.testCase.name}`;
  });
  return [
    "",
    `${C.grey}${"═".repeat(78)}${C.reset}`,
    `${C.bold}SUMMARY${C.reset}`,
    "",
    ...rows,
    "",
    `  ${C.green}${counts.send} would send${C.reset} · ${C.yellow}${counts.held} held${C.reset} · ${C.grey}${counts.skipped} skipped${C.reset}${counts.error ? ` · ${C.red}${counts.error} error${C.reset}` : ""}`,
    checked ? `  ${matched}/${checked} matched their @expect` : "",
    "",
  ].filter((l) => l !== "").join("\n");
}

export function renderMarkdown(results: CaseResult[], meta: { when: string; slotsNote: string }): string {
  const out: string[] = [
    `# Reply Gate sandbox run`,
    ``,
    `${meta.when} · ${results.length} cases · ${meta.slotsNote}`,
    ``,
    `| | Outcome | Bucket | Conf | Case |`,
    `|---|---|---|---|---|`,
  ];
  for (const r of results) {
    const m = matchesExpectation(r);
    out.push(`| ${m === null ? "" : m ? "✓" : "✗"} | ${PLAIN[r.outcome]} | ${r.bucket ?? "-"} | ${r.confidence?.toFixed(2) ?? "-"} | ${r.testCase.name} |`);
  }
  for (const r of results) {
    const t = r.testCase;
    out.push(``, `---`, ``, `## ${t.name} — ${PLAIN[r.outcome]}`, ``);
    if (t.expect) out.push(`Expected \`${t.expect}\` · ${matchesExpectation(r) ? "matched" : "**did not match**"}`, ``);
    out.push(`**They wrote:**`, ``, quote(t.body), ``);
    if (r.bucket) out.push(`**Classified:** \`${r.bucket}\` @ ${r.confidence?.toFixed(2)}${r.retried ? " (after retry)" : ""}`, ``, `> ${r.reasoning ?? ""}`, ``);
    if (r.draft) out.push(`**${r.outcome === "send" ? "Would reply" : "Draft (not sent)"}:**`, ``, quote(r.draft), ``);
    if (r.checkFailures?.length) out.push(`**Code checks failed:** ${r.checkFailures.join("; ")}`, ``);
    if (r.verifier) {
      out.push(`**Verifier:** ${Object.entries(r.verifier.criteria).map(([k, v]) => `${v?.pass ? "✓" : "✗"} ${k}`).join(" · ")}`, ``);
      for (const [k, v] of Object.entries(r.verifier.criteria)) {
        if (!v?.pass) out.push(`- \`${k}\`: ${v.evidence}`, ``);
      }
    }
    if (r.reason) out.push(`**Why:** ${r.reason}`, ``);
  }
  return out.join("\n") + "\n";
}

export function renderHtml(results: CaseResult[], meta: { when: string; slotsNote: string }): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
  const cards = results.map((r) => {
    const t = r.testCase;
    const m = matchesExpectation(r);
    const parts = [
      `<article class="card ${r.outcome}">`,
      `<header><span class="badge">${PLAIN[r.outcome]}</span><h2>${esc(t.name)}</h2>`,
      t.expect ? `<span class="expect ${m ? "ok" : "bad"}">expected ${esc(t.expect)}${m ? " ✓" : " ✗"}</span>` : "",
      `</header>`,
      `<p class="who">${esc([t.first_name, t.company_name].filter(Boolean).join(" @ ") || "")} &middot; ${esc(t.email)}</p>`,
      `<div class="cols">`,
      `<section><h3>They wrote</h3><pre>${esc(t.body)}</pre></section>`,
      `<section><h3>${r.outcome === "send" ? "We would reply" : "Draft (not sent)"}</h3>${r.draft ? `<pre class="draft">${esc(r.draft)}</pre>` : `<p class="none">no draft produced</p>`}</section>`,
      `</div>`,
      r.bucket ? `<p class="meta"><b>${esc(r.bucket)}</b> @ ${r.confidence?.toFixed(2)}${r.retried ? " (after retry)" : ""} &middot; ${esc(r.reasoning ?? "")}</p>` : "",
      r.checkFailures?.length ? `<p class="fail">Code checks failed: ${esc(r.checkFailures.join("; "))}</p>` : "",
      r.verifier ? `<p class="meta">Verifier: ${Object.entries(r.verifier.criteria).map(([k, v]) => `<span class="${v?.pass ? "ok" : "bad"}">${v?.pass ? "✓" : "✗"} ${esc(k)}</span>`).join(" ")}</p>` : "",
      r.reason ? `<p class="why">${esc(r.reason)}</p>` : "",
      `</article>`,
    ];
    return parts.filter(Boolean).join("\n");
  }).join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Reply Gate sandbox</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#1a1a1a}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#666;margin:0 0 24px}
.card{background:#fff;border-radius:10px;padding:16px 18px;margin:0 0 16px;border-left:5px solid #ccc;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.card.send{border-color:#1a9e4b}.card.held{border-color:#d99b00}.card.skipped{border-color:#999}.card.error{border-color:#d33}
header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h2{font-size:16px;margin:0}
.badge{font-size:11px;font-weight:700;letter-spacing:.05em;padding:3px 8px;border-radius:99px;background:#eee}
.send .badge{background:#e3f6ea;color:#127a3a}.held .badge{background:#fdf1d8;color:#8a6100}.skipped .badge{background:#eee;color:#666}.error .badge{background:#fbe3e3;color:#a11}
.expect{font-size:12px;padding:2px 7px;border-radius:99px}.expect.ok{background:#e3f6ea;color:#127a3a}.expect.bad{background:#fbe3e3;color:#a11}
.who{color:#777;font-size:13px;margin:4px 0 12px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:800px){.cols{grid-template-columns:1fr}}
h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#888;margin:0 0 6px}
pre{white-space:pre-wrap;word-wrap:break-word;background:#f7f7f9;padding:10px 12px;border-radius:6px;margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto}
pre.draft{background:#f0f7f2}
.card.held pre.draft,.card.error pre.draft{background:#fdf8ec}
.none{color:#aaa;font-style:italic;margin:0}
.meta{font-size:13px;color:#555;margin:12px 0 0}
.why{font-size:13px;background:#fdf6e6;border-radius:6px;padding:9px 11px;margin:10px 0 0}
.fail{font-size:13px;color:#a11;margin:10px 0 0}
.ok{color:#127a3a}.bad{color:#a11}
@media(prefers-color-scheme:dark){
body{background:#16171a;color:#e6e6e6}.card{background:#1f2125;box-shadow:none}
pre{background:#26282d}pre.draft{background:#1f2a22}.card.held pre.draft{background:#2b2519}
.why{background:#2b2519}.who,.meta{color:#9aa0a6}.sub{color:#9aa0a6}
.badge{background:#33363b;color:#ccc}
}
</style></head><body>
<h1>Reply Gate sandbox</h1>
<p class="sub">${esc(meta.when)} &middot; ${results.length} cases &middot; ${esc(meta.slotsNote)} &middot; nothing was sent, logged, or posted to Slack</p>
${cards}
</body></html>`;
}

function indent(s: string, pad: string): string {
  return s.split("\n").map((l) => pad + l).join("\n");
}
function wrap(s: string, width: number): string {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) { lines.push(line.trim()); line = w; }
    else line += " " + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n");
}
function quote(s: string): string {
  return s.split("\n").map((l) => "> " + l).join("\n");
}
