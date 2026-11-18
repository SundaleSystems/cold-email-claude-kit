#!/usr/bin/env tsx
/**
 * Verify one or a few emails in real time with MillionVerifier's Single API,
 * or just check the credits balance.
 *
 * Usage:
 *   npx tsx skills/millionverifier/scripts/single-verify.ts --email=jane@acme.com
 *   npx tsx skills/millionverifier/scripts/single-verify.ts --email=a@x.com,b@y.com
 *   npx tsx skills/millionverifier/scripts/single-verify.ts --credits
 *
 * For lists of more than ~25 emails, use bulk-verify.ts instead (1 credit per
 * email either way, but bulk is one upload instead of N requests).
 *
 * Requires MILLIONVERIFIER_API_KEY (repo-root .env or exported).
 * Dry run without credits: MILLIONVERIFIER_API_KEY=API_KEY_FOR_TEST (random results).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SINGLE_BASE = "https://api.millionverifier.com";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function findEnvFile(): string | null {
  // Walk up from the script dir (works from skills/ and .claude/skills/), then try CWD.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const cwdEnv = path.resolve(process.cwd(), ".env");
  return fs.existsSync(cwdEnv) ? cwdEnv : null;
}
function loadEnv(): Record<string, string> {
  const envPath = findEnvFile();
  const out: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (!envPath) return out;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!out[key]) out[key] = val;
  }
  return out;
}
const API_KEY = loadEnv().MILLIONVERIFIER_API_KEY;
if (!API_KEY) {
  console.error("Missing env: MILLIONVERIFIER_API_KEY. Add it to .env (see .env.example).");
  process.exit(1);
}

async function fetchJson(url: string, attempts = 4): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url).catch(() => null);
    if (resp && resp.ok) return resp.json();
    if (resp && resp.status < 500 && resp.status !== 429) {
      throw new Error(`HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
    }
    if (attempt >= attempts) throw new Error(`HTTP ${resp?.status ?? "network error"} after ${attempts + 1} attempts`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const emailsArg = args.find((a) => a.startsWith("--email="))?.slice("--email=".length);

  if (args.includes("--credits") || !emailsArg) {
    const info = await fetchJson(`${SINGLE_BASE}/api/v3/credits?api=${API_KEY}`);
    console.log(`Credits: ${info.credits ?? 0}  (renewing: ${info.renewing_credits ?? 0}, plan: ${info.plan ?? "?"})`);
    if (!emailsArg) {
      if (!args.includes("--credits")) console.error("Usage: --email=a@x.com[,b@y.com] | --credits");
      return;
    }
  }

  const emails = emailsArg!.split(",").map((s) => s.trim()).filter(Boolean);
  let credits: number | undefined;
  for (const email of emails) {
    const r = await fetchJson(`${SINGLE_BASE}/api/v3/?api=${API_KEY}&email=${encodeURIComponent(email)}&timeout=10`);
    credits = r.credits;
    const flags = [r.free ? "free" : "", r.role ? "role" : ""].filter(Boolean).join(",");
    const extra = [
      r.subresult ? `subresult=${r.subresult}` : "",
      flags ? `[${flags}]` : "",
      r.didyoumean ? `did you mean ${r.didyoumean}?` : "",
      r.error ? `error=${r.error}` : "",
    ].filter(Boolean).join(" ");
    console.log(`${email.padEnd(40)} ${String(r.result).padEnd(10)} quality=${r.quality || "-"} ${extra}`.trim());
  }
  if (credits !== undefined) console.error(`\nCredits remaining: ${credits}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
