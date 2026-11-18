// Skip the noise: out-of-office, bounces and unsubscribes are dropped
// before any AI is involved. Cheap, deterministic, and first.
import type { InboundReply } from "./types.ts";

const OOO_PATTERNS = [
  /out of (the )?office/i,
  /on annual leave/i,
  /on (vacation|holiday)/i,
  /automatic reply/i,
  /auto-?reply/i,
  /away from (my )?email/i,
  /parental leave/i,
  /maternity leave/i,
  /limited access to (my )?email/i,
  /will (be )?(back|return)/i,
  /currently (out|away|travell?ing)/i,
];

const BOUNCE_PATTERNS = [
  /mailer-?daemon/i,
  /postmaster@/i,
  /delivery (status notification|has failed|failure)/i,
  /undeliverable/i,
  /address not found/i,
  /mailbox (unavailable|full|not found)/i,
  /returned to sender/i,
];

const UNSUB_PATTERNS = [
  /unsubscribe/i,
  /remove me( from (your|this) list)?/i,
  /take me off/i,
  /stop (emailing|contacting|sending)/i,
  /do not (contact|email) me/i,
  /opt me out/i,
];

export function classifyNoise(reply: InboundReply): string | null {
  const text = `${reply.subject}\n${stripQuoted(reply.text)}`;
  if (reply.isAutoReply || OOO_PATTERNS.some((p) => p.test(text))) return "auto-reply / out-of-office";
  if (BOUNCE_PATTERNS.some((p) => p.test(text))) return "bounce notification";
  // Unsubscribes only count when the message is short and clearly that —
  // "I'd love to unsubscribe from bad vendors, but you look interesting"
  // must not be skipped.
  const own = stripQuoted(reply.text);
  if (own.length < 300 && UNSUB_PATTERNS.some((p) => p.test(own))) return "unsubscribe request";
  return null;
}

/**
 * Strip quoted thread history (">"-prefixed lines and everything after
 * an "On ... wrote:" marker) so we analyse only what the prospect
 * actually typed — the quoted thread contains OUR OWN email, including
 * our Calendly link.
 */
export function stripQuoted(text: string): string {
  const marker = text.search(/^\s*On .{0,120}(wrote|écrit|schrieb):\s*$/mi);
  let own = marker >= 0 ? text.slice(0, marker) : text;
  own = own.split("\n").filter((l) => !l.trimStart().startsWith(">")).join("\n");
  const sep = own.search(/^-{2,}\s*(Original Message|Forwarded message)/mi);
  if (sep >= 0) own = own.slice(0, sep);
  return own.trim();
}

// Prospect sent THEIR scheduling link → do not reply. you book the
// meeting in their calendar and replies manually.
const SCHEDULING_LINK = /(calendly\.com|cal\.com|savvycal\.com|tidycal\.com|youcanbook\.me|acuityscheduling\.com|meetings\.hubspot\.com|appt\.link|zcal\.co|meetfox\.com)\/[^\s>)"']+/i;

export function detectSchedulingLink(ownText: string, ourCalendlyUrl?: string | null): string | null {
  const m = ownText.match(SCHEDULING_LINK);
  if (!m) return null;
  // Ignore our own link if it somehow survives quote-stripping.
  if (ourCalendlyUrl && m[0].toLowerCase().includes(new URL(ourCalendlyUrl).pathname.toLowerCase())) return null;
  return m[0];
}
