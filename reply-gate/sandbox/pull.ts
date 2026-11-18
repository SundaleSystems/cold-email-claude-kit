#!/usr/bin/env -S deno run -A
// Refresh sandbox/data/offer-sheets.json from the live Supabase project.
//
// Read-only. Uses the Supabase Management API with SUPABASE_ACCESS_TOKEN
// (your CLI personal access token) so the sandbox never needs the service
// role key. Run it whenever you change knowledge_base in the dashboard:
//
//   deno run -A sandbox/pull.ts
//
// After pulling you can edit data/offer-sheets.json freely — the harness
// reads the local file, so you can try copy changes without touching prod.
import { parseEnvFile } from "./lib/env.ts";

// decodeURIComponent: the workspace path contains spaces, which arrive
// percent-encoded in a file:// URL.
const HERE = decodeURIComponent(new URL(".", import.meta.url).pathname);
const ENV_PATH = `${HERE}../../.env`;
const REF_PATH = `${HERE}../supabase/.temp/linked-project.json`;
const OUT_PATH = `${HERE}data/offer-sheets.json`;

const env = parseEnvFile(Deno.readTextFileSync(ENV_PATH));
const token = env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error("SUPABASE_ACCESS_TOKEN missing from .env");

const ref = Deno.env.get("SUPABASE_PROJECT_REF") ??
  JSON.parse(Deno.readTextFileSync(REF_PATH)).ref;

async function query(sql: string): Promise<any[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`management api ${res.status}: ${await res.text()}`);
  return await res.json();
}

const sheets = await query("select * from knowledge_base order by is_global desc, key");
const campaigns = await query("select * from campaign_map order by campaign_name");

await Deno.mkdir(`${HERE}data`, { recursive: true });
Deno.writeTextFileSync(
  OUT_PATH,
  JSON.stringify({ pulled_from: ref, sheets, campaigns }, null, 2) + "\n",
);

console.log(`Pulled from ${ref}`);
for (const s of sheets) {
  const unfinished = JSON.stringify(s).includes("FILL ME IN") ? "  (contains FILL ME IN)" : "";
  console.log(`  offer sheet: ${s.key}${s.is_global ? " [global]" : ""}${unfinished}`);
}
for (const c of campaigns) {
  console.log(`  campaign: ${c.campaign_name} -> ${c.offer_key} (live=${c.live})`);
}
console.log(`\nWrote ${OUT_PATH.replace(HERE, "sandbox/")}`);
