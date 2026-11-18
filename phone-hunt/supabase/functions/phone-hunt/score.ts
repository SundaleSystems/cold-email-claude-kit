// Merge candidates from every source, dedupe by number, and score.
// Ported from the n8n "Score & Build Email" node (scoring half only —
// the alert formatting lives in notify.ts).
import type { HuntResult, PhoneCandidate, ScoredPhone, SigNumber } from "./types.ts";

export function digitsOf(s: unknown): string {
  return String(s ?? "").replace(/\D/g, "").slice(-10);
}

export function pretty(d: string): string {
  return d.length === 10 ? `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d;
}

/** Signature numbers → scored candidates. mobile 95, unknown 70, office 40. */
export function candidatesFromSignature(sigNumbers: SigNumber[]): PhoneCandidate[] {
  return sigNumbers.map((n) => {
    const base = { digits: n.digits, source: "email signature", note: n.label, ext: n.ext };
    if (n.type === "mobile") return { ...base, score: 95, type: "mobile" as const };
    if (n.type === "office") return { ...base, score: 40, type: "office" as const };
    return { ...base, score: 70, type: "unknown" as const };
  });
}

/**
 * Dedupe by 10-digit number: keep the best score, remember every source,
 * and let a mobile classification win over office/unknown. Two or more
 * independent sources on the same number earns +15 (capped at 99).
 */
export function scoreAndSort(candidates: PhoneCandidate[]): HuntResult {
  const byDigits = new Map<string, ScoredPhone & { sources: Set<string> }>();
  for (const c of candidates) {
    const cur = byDigits.get(c.digits);
    if (!cur) {
      byDigits.set(c.digits, { ...c, sourceList: c.source, sources: new Set([c.source]) });
    } else {
      cur.sources.add(c.source);
      if (c.score > cur.score) {
        cur.score = c.score;
        cur.note = c.note;
        cur.source = c.source;
      }
      if (c.type === "mobile") cur.type = "mobile";
      else if (cur.type === "unknown" && c.type === "office") cur.type = "office";
      // An extension only ever comes from the signature — keep it even if
      // another source (with no extension) set the winning score.
      if (!cur.ext && c.ext) cur.ext = c.ext;
    }
  }

  const merged: ScoredPhone[] = [...byDigits.values()].map((c) => {
    if (c.sources.size >= 2) {
      c.score = Math.min(99, c.score + 15);
      c.note += ` — corroborated by ${c.sources.size} sources`;
    }
    c.sourceList = [...c.sources].join(" + ");
    // Drop the internal Set before returning a clean ScoredPhone.
    const { sources: _sources, ...clean } = c;
    return clean;
  });

  const mobiles = merged.filter((c) => c.type !== "office").sort((a, b) => b.score - a.score);
  const others = merged.filter((c) => c.type === "office").sort((a, b) => b.score - a.score);
  return { mobiles, others };
}
