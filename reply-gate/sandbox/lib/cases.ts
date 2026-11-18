// Parser for the test-reply files in sandbox/cases/.
//
// Format — one case per "## " heading, optional "@key: value" lines
// directly under it, then the reply body verbatim until the next "## ":
//
//   ## Straight yes
//   @first_name: Sean
//   @company: Acme Plumbing
//   @website: acmeplumbing.com
//   @expect: positive_interested
//   Sounds great, let's do it. When are you free?
//
// Everything is optional except the heading and a body.

export interface TestCase {
  name: string;
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  website?: string;
  subject: string;
  isAutoReply: boolean;
  offer: string;
  expect?: string; // expected bucket, or "skipped" / "held"
  note?: string;
  body: string;
}

const DEFAULT_OFFER = "ai-cold-email-system";

export function parseCases(text: string, defaultOffer = DEFAULT_OFFER): TestCase[] {
  const lines = text.split("\n");
  const cases: TestCase[] = [];

  let current: { name: string; meta: Record<string, string>; body: string[] } | null = null;
  let inMeta = false;

  const flush = () => {
    if (!current) return;
    const m = current.meta;
    const body = current.body.join("\n").trim();
    if (!body) throw new Error(`Case "${current.name}" has no reply body.`);
    const first = m.first_name?.trim();
    cases.push({
      name: current.name,
      email: m.email?.trim() || synthEmail(current.name, m.company_name),
      first_name: first || undefined,
      last_name: m.last_name?.trim() || undefined,
      company_name: m.company_name?.trim() || m.company?.trim() || undefined,
      website: m.website?.trim() || undefined,
      subject: m.subject?.trim() || "Re: quick question",
      isAutoReply: (m.auto_reply ?? "").trim().toLowerCase() === "true",
      offer: m.offer?.trim() || defaultOffer,
      expect: m.expect?.trim() || undefined,
      note: m.note?.trim() || undefined,
      body,
    });
    current = null;
  };

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      flush();
      current = { name: line.replace(/^##\s+/, "").trim(), meta: {}, body: [] };
      inMeta = true;
      continue;
    }
    if (!current) continue; // preamble / prose between cases
    const meta = inMeta ? line.match(/^@([a-z_]+):\s?(.*)$/i) : null;
    if (meta) {
      current.meta[meta[1].toLowerCase()] = meta[2];
      continue;
    }
    if (inMeta && line.trim() === "") continue; // blank line between meta and body
    inMeta = false;
    current.body.push(line);
  }
  flush();

  if (cases.length === 0) throw new Error("No cases found — each case needs a '## Name' heading.");
  return cases;
}

function synthEmail(name: string, company?: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug(name).slice(0, 30)}@${company ? slug(company) : "example"}.com`;
}
