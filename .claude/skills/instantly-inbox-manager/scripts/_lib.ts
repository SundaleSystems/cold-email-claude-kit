/**
 * Shared utilities for instantly-inbox-manager scripts.
 */

export const API_BASE = "https://api.instantly.ai/api/v2";
export const API_KEY = process.env.INSTANTLY_API_KEY;

if (!API_KEY) {
  console.error("Missing env var: INSTANTLY_API_KEY");
  process.exit(1);
}

export function parseFlag(
  args: string[],
  flag: string,
  defaultValue?: string
): string | undefined {
  const arg = args.find((a) => a.startsWith(`${flag}=`));
  return arg ? arg.split("=").slice(1).join("=") : defaultValue;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export interface InboxTag {
  id: string;
  label: string;
}

/**
 * Instantly account object (subset). Accounts are keyed by EMAIL ADDRESS,
 * not a numeric id.
 */
export interface InboxAccount {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  /** 1 Active, 2 Paused, -1 Connection Error, -2 Soft Ban, -3 Sending Error */
  status?: number;
  /** 0 Paused, 1 Active, -1 Banned, -2 Spam Folder Unknown, -3 Permanent Suspension */
  warmup_status?: number;
  /** 0-100 warmup health score (null until Instantly computes one) */
  stat_warmup_score?: number | null;
  /** Warmup settings. increment is a string enum: "disabled" | "0".."4" (slow ramp). */
  warmup?: {
    limit?: number;
    increment?: string;
    reply_rate?: number;
    [key: string]: any;
  };
  daily_limit?: number | null;
  signature?: string | null;
  /** 1 custom IMAP/SMTP, 2 Google, 3 Microsoft, 4/8 other */
  provider_code?: number;
  setup_pending?: boolean;
  /** Populated when listing with include_tags=true; array of {id,label}. */
  tags?: InboxTag[] | null;
  [key: string]: any;
}

/**
 * Bearer-auth fetch against the Instantly API. `path` is relative to API_BASE.
 * Retries 5x with exponential backoff on 429/5xx.
 */
export async function fetchJson(path: string, options: RequestInit = {}): Promise<any> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
    if (resp.status === 429 || resp.status >= 500) {
      const wait = 1000 * 2 ** attempt;
      console.error(`  [${resp.status}] retry ${attempt + 1}/5 in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    return resp.json();
  }
  throw new Error("Exhausted retries");
}

export async function listAllInboxes(): Promise<InboxAccount[]> {
  const all: InboxAccount[] = [];
  let cursor: string | undefined;
  while (true) {
    const qs = `limit=100&include_tags=true${
      cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""
    }`;
    const page = await fetchJson(`/accounts?${qs}`);
    const items: InboxAccount[] = page.items ?? [];
    all.push(...items);
    if (!page.next_starting_after || items.length === 0) break;
    cursor = page.next_starting_after;
  }
  return all;
}

/**
 * Resolve a tag label to its custom-tag object via GET /custom-tags?search=,
 * using an exact case-insensitive label match. Returns undefined if no tag
 * with that label exists.
 */
export async function findTagByLabel(label: string): Promise<InboxTag | undefined> {
  const want = label.trim().toLowerCase();
  const page = await fetchJson(`/custom-tags?limit=100&search=${encodeURIComponent(label.trim())}`);
  const items: any[] = page.items ?? [];
  const match = items.find((t) => String(t.label ?? "").trim().toLowerCase() === want);
  return match ? { id: match.id, label: match.label } : undefined;
}

function tagLabel(t: any): string {
  // Tags arrive as {id,label} objects when include_tags=true; be lenient anyway.
  return typeof t === "string" ? t : String(t?.label ?? "");
}

export function accountHasTag(a: InboxAccount, label: string): boolean {
  const want = label.trim().toLowerCase();
  return (a.tags ?? []).some((t) => tagLabel(t).trim().toLowerCase() === want);
}

/**
 * Poll a background job (returned by bulk operations like warmup enable/disable)
 * every `intervalMs` until it reaches success/failed. On timeout, prints the job
 * id so the caller can check on it later and returns the last-seen job.
 */
export async function pollBackgroundJob(
  jobId: string,
  timeoutMs = 120_000,
  intervalMs = 3000
): Promise<any> {
  const start = Date.now();
  while (true) {
    const job = await fetchJson(`/background-jobs/${jobId}`);
    if (job.status === "success" || job.status === "failed") return job;
    if (Date.now() - start > timeoutMs) {
      console.error(
        `  Job still processing after ${Math.round(timeoutMs / 1000)}s ` +
          `(id: ${jobId}, status: ${job.status}, progress: ${job.progress ?? 0}%). ` +
          `Check later: GET /api/v2/background-jobs/${jobId}`
      );
      return job;
    }
    console.error(`  job ${job.status} (${job.progress ?? 0}%)...`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Given selector args, return the filtered list of inboxes.
 *
 * Supported flags:
 *   --all
 *   --emails=a@x.com,b@y.com   (--ids= accepted as a backward-compat alias)
 *   --domain=example.com
 *   --tag=active
 *   --ids-from-csv=path (expects an `email` header column; an `id` column
 *                        also works — values are treated as email addresses)
 */
export async function selectInboxes(args: string[]): Promise<InboxAccount[]> {
  const all = await listAllInboxes();

  if (hasFlag(args, "--all")) return all;

  // Instantly accounts are keyed by email; --ids= is kept as an alias.
  const emails = parseFlag(args, "--emails") ?? parseFlag(args, "--ids");
  if (emails) {
    const emailSet = new Set(
      emails.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)
    );
    return all.filter((a) => emailSet.has((a.email || "").toLowerCase()));
  }

  const domain = parseFlag(args, "--domain");
  if (domain) {
    return all.filter((a) => (a.email || "").toLowerCase().endsWith(`@${domain.toLowerCase()}`));
  }

  const tag = parseFlag(args, "--tag");
  if (tag) {
    return all.filter((a) => accountHasTag(a, tag));
  }

  const csv = parseFlag(args, "--ids-from-csv");
  if (csv) {
    const { readFileSync } = require("fs");
    const text = readFileSync(csv, "utf8");
    const lines = text.trim().split("\n");
    const header = lines[0].split(",").map((h: string) => h.trim().replace(/^"|"$/g, ""));
    let col = header.indexOf("email");
    if (col < 0) col = header.indexOf("id"); // legacy column name; values treated as emails
    if (col < 0) throw new Error(`CSV ${csv} missing 'email' (or 'id') column`);
    const emailSet = new Set(
      lines
        .slice(1)
        .map((l: string) => l.split(",")[col]?.trim().replace(/^"|"$/g, "").toLowerCase())
        .filter(Boolean)
    );
    return all.filter((a) => emailSet.has((a.email || "").toLowerCase()));
  }

  console.error(
    "No selector provided. Use --all, --emails=..., --domain=..., --tag=..., or --ids-from-csv=path"
  );
  process.exit(1);
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const queue = items.map((item, idx) => ({ item, idx }));
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length) {
      const { item, idx } = queue.shift()!;
      try {
        results[idx] = await worker(item, idx);
      } catch (err) {
        results[idx] = { error: String(err) } as any;
      }
    }
  });
  await Promise.all(runners);
  return results;
}
