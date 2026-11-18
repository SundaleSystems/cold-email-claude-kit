// Pull phone numbers out of the reply's email signature. Free, always
// runs, and the highest-signal source when the prospect actually signs
// off with a cell. Ported from the n8n "Parse Signature" node.
import type { SigNumber } from "./types.ts";

export function stripHtml(html: string): string {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Remove the quoted/forwarded original so we never scrape our own
 * signature back out — while KEEPING the prospect's own signature, which
 * (in Gmail/Apple Mail replies) sits at the BOTTOM, below the quote.
 *
 * Two quote styles:
 *  - Outlook top-posts: everything after "-----Original Message-----" or
 *    a "From:/Sent:" block is the quoted original → hard-cut it.
 *  - Gmail/Apple/standard: the original is quoted line-by-line with ">"
 *    → drop those lines and the "On <date> … wrote:" attribution. The
 *    prospect's reply and a below-the-quote signature both survive.
 */
export function cutQuotedHistory(text: string): string {
  let out = text;

  // Outlook-style: quoted original follows these markers with no ">" prefix.
  const hardCuts = [/-{3,}\s*Original Message\s*-{3,}/i, /\n\s*From:\s.+\n\s*Sent:\s/i];
  for (const m of hardCuts) {
    const match = out.match(m);
    if (match && match.index !== undefined && match.index > 40) {
      out = out.slice(0, match.index);
    }
  }

  // Standard "> " quoting: drop quoted lines, then strip the attribution
  // line ("On <date> <name> wrote:"), which can span two lines.
  out = out
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/On .{5,300}?wrote:/gs, "");

  return out;
}

/**
 * Extract NANP numbers and classify each by the 25 characters that
 * precede it: a "m:" / "cell" prefix means mobile, "o:" / "office" means
 * office, "fax" means throw it away. Numbers equal to the company
 * switchboard are dropped.
 */
export function parseSignature(
  replyText: string,
  replyHtml: string,
  companyPhone: string,
): SigNumber[] {
  // Strip angle-bracket URL/email tokens ("... ext.  <tel:(516)555-0192ext.31>21")
  // that email clients inline into plain text — they garble the number and its
  // extension. Removing them de-garbles "ext.  <...>21" back to "ext.  21".
  const text = cutQuotedHistory(
    replyText && replyText.trim() ? replyText : stripHtml(replyHtml),
  ).replace(/<[^>]{0,300}>/g, " ");

  const companyDigits = String(companyPhone || "").replace(/\D/g, "").slice(-10);

  const sigNumbers: SigNumber[] = [];
  const seen = new Set<string>();
  const re = /(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = m[1] + m[2] + m[3];
    if (seen.has(digits)) continue;
    seen.add(digits);
    if (companyDigits && digits === companyDigits) continue; // company switchboard

    // Label window: the 25 chars before the number, trimmed to the
    // current line. Signatures put the label inline ("M: 555-…"), and
    // trimming to the line stops an earlier number's label (e.g. a
    // "Fax:" one line up) from bleeding in and mislabeling this one.
    const before = text
      .slice(Math.max(0, m.index - 25), m.index)
      .split(/[\r\n]/).pop()!
      .toLowerCase();
    let type: SigNumber["type"] = "unknown";
    let label = "unlabeled";
    if (/\bf(ax)?\s*[.:]/.test(before) || /\bfax\b/.test(before)) continue; // fax -> discard
    if (/\b(m|c)\s*[.:]|\bcell\b|\bmob(ile)?\b|\btext\b/.test(before)) {
      type = "mobile";
      label = "labeled mobile/cell";
    } else if (
      /\b(o|t|d|w)\s*[.:]|\btel\b|\bdirect\b|\boffice\b|\bmain\b|\bwork\b|\bphone\s*[.:]/.test(before)
    ) {
      type = "office";
      label = "labeled office/direct";
    }

    // Capture a dialing extension that immediately follows the number
    // ("ext. 21", "x21", "extension 21", "#21").
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 18);
    const extMatch = after.match(/^[\s.]*(?:ext|extension|x|#)\.?\s*:?\s*(\d{1,6})/i);
    const ext = extMatch ? extMatch[1] : undefined;

    sigNumbers.push({ digits, type, label, ext });
  }
  return sigNumbers;
}
