// Reply classification scheme: every reply lands in exactly one
// bucket. Only the positive buckets have templates and can auto-reply;
// everything else is held or skipped.
export type Bucket =
  | "positive_interested"   // "yes, tell me more" / agreed to the call
  | "positive_owntime"      // proposes their own specific time: "how is 3pm Monday?"
  | "positive_price"        // "what's the price?"
  | "positive_soft_info"    // "send more info" / info request
  | "positive_soft_later"   // "reach out in Q3" / another time
  | "positive_referral"     // "not me, but talk to X"
  | "neutral_question"      // clarifying question, no commitment
  | "negative_notnow"
  | "negative_notfit"
  | "negative_hostile"      // track separately as a risk signal
  | "unsubscribe"
  | "ooo"
  | "bounce"
  | "other";                // can't tell

export const AUTO_REPLY_BUCKETS = new Set<Bucket>([
  "positive_interested",
  "positive_owntime",
  "positive_price",
  "positive_soft_info",
  "positive_soft_later",
  "positive_referral",
]);

// Buckets that reach the drafter but are conversations, not replies.
// negative_hostile is flagged loudly in Slack as a risk signal.
export const HOLD_REASONS: Partial<Record<Bucket, string>> = {
  neutral_question: "Clarifying question with no template — answer it yourself (and consider adding it to common_questions).",
  negative_notnow: "Negative (not now). No auto-reply for negative buckets, by design.",
  negative_notfit: "Negative (not a fit). No auto-reply for negative buckets, by design.",
  negative_hostile: "HOSTILE reply — risk signal. Review the thread and consider suppressing the lead.",
  unsubscribe: "Unsubscribe request that slipped past the noise filter.",
  ooo: "Out-of-office that slipped past the noise filter.",
  bounce: "Bounce that slipped past the noise filter.",
  other: "Could not classify — anything the model cannot classify goes to a human.",
};

export interface OfferSheet {
  key: string;
  is_global: boolean;
  offer_name: string | null;
  original_pitch: string | null;
  sender_name: string | null;
  sender_role: string | null;
  sender_signoff: string | null;
  offer_facts: string | null;
  high_level_answer: string | null;   // 1-2 sentence description for soft-info replies
  pricing_policy: "quote_number" | "quote_range" | "no_price_before_call";
  pricing_facts: string | null;       // e.g. "$X-Yk/month (FILL ME IN)" — quoted verbatim, never paraphrased
  lead_magnet: string | null;         // the no-strings freebie in the price reply
  price_reply: string | null;         // full body override for the price reply; null = use the pricing_facts template
  calendly_url: string | null;
  common_questions: { q: string; a: string }[];
  ideal_replies: string[];
  voice_rules: string | null;
  max_words: number;
  banned_phrases: string[];
  business_noun: string | null;
  timezone: string | null;
}

export interface CampaignMapping {
  campaign_id: string;
  campaign_name: string | null;
  offer_key: string;
  live: boolean;
}

export interface Lead {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  website?: string;
  city?: string;
  personalization?: string; // the personalised opening line the original email used
}

export interface InboundReply {
  id: string; // Instantly email id → reply_to_uuid
  subject: string;
  text: string;
  eaccount: string; // mailbox that ran the campaign
  campaignId: string;
  leadEmail: string;
  isAutoReply: boolean;
}

export interface CalendarSlots {
  ok: boolean;
  slots: string[]; // human-formatted, e.g. "Tuesday at 3:00 PM ET"
  schedulingUrl?: string;
  error?: string;
}

export interface Classification {
  reasoning: string;
  bucket: Bucket;
  confidence: number;
  // positive_soft_later: their timeframe ("Q3", "next quarter").
  // positive_owntime: their proposed time, in their words ("3pm on Monday").
  timeframe?: string;
}

export interface CheckResult {
  pass: boolean;
  failures: string[];
  detail: Record<string, boolean>;
}

export interface VerifierCriterion {
  evidence: string;
  pass: boolean;
}

export interface VerifierResult {
  analysis: string;
  criteria: Record<string, VerifierCriterion>;
  overall_pass: boolean;
  feedback: string;
}
