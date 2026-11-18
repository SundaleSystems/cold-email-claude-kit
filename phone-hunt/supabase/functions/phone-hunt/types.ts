// Shared shapes for the phone-hunt pipeline.

export type PhoneType = "mobile" | "office" | "unknown";

/** A number pulled out of the reply's email signature. */
export interface SigNumber {
  digits: string; // exactly 10 digits, NANP, no country code
  type: PhoneType;
  label: string; // e.g. "labeled mobile/cell", "unlabeled"
  ext?: string; // dialing extension, e.g. "21", when the signature has one
}

/** A raw candidate from any source, before dedupe/merge. */
export interface PhoneCandidate {
  digits: string;
  score: number;
  type: PhoneType;
  source: string; // "email signature" | "SkipTrace" | "LeadMagic"
  note: string;
  ext?: string; // dialing extension, carried through from the signature
}

/** A merged candidate after dedupe + cross-source corroboration. */
export interface ScoredPhone extends PhoneCandidate {
  sourceList: string; // "email signature + LeadMagic"
}

/** Everything the hunt needs to know about the lead, from webhook + API. */
export interface LeadKeys {
  eventType: string;
  campaignId: string;
  campaignName: string;
  firstName: string;
  lastName: string;
  email: string;
  companyName: string;
  industry: string;
  locationRaw: string;
  city: string | null;
  state: string | null;
  linkedinUrl: string;
  companyPhone: string;
  replyText: string; // plain text, HTML already stripped
}

/** Per-source outcome, shown in the alert footer and stored in the log. */
export type SourceStatus = Record<string, string>;

export interface SourceResult {
  candidates: PhoneCandidate[];
  status: string; // "ok:2", "skipped:no-location", "timeout", "http:402", ...
}

export interface HuntResult {
  mobiles: ScoredPhone[];
  others: ScoredPhone[];
}

export interface InboundReply {
  id: string;
  subject: string;
  text: string;
  html: string;
}

export interface InstantlyLead {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  custom_variables: Record<string, unknown>;
}
