#!/usr/bin/env tsx
/**
 * Bulk add/remove tags on Instantly sending accounts.
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   npx tsx scripts/tag-inboxes.ts --tag=new --add=insurance
 *   npx tsx scripts/tag-inboxes.ts --tag=insurance --remove=insurance --add=active
 *   npx tsx scripts/tag-inboxes.ts --emails=a@x.com,b@y.com --add=active
 *
 * Selector flags: --all, --emails=... (--ids= alias), --domain=..., --tag=..., --ids-from-csv=path
 * Actions (can combine): --add=name, --remove=name
 *   (--add-tag= / --remove-tag= are accepted as backward-compat aliases)
 *
 * Simplification vs the previous version: Instantly tags are first-class
 * custom-tag objects, and POST /custom-tags/toggle-resource assigns or
 * unassigns a tag across many accounts in ONE call. That replaces the old
 * read-modify-write "replace the whole tag list per inbox" hack, so there is
 * no per-inbox loop here. Instantly tags also have no color, so the old
 * name:color syntax is gone.
 */

import { parseFlag, selectInboxes, fetchJson, findTagByLabel, InboxTag } from "./_lib";

/** Find the tag by label; create it if missing (used for --add). */
async function ensureTag(label: string): Promise<InboxTag> {
  const existing = await findTagByLabel(label);
  if (existing) return existing;
  console.error(`  Tag "${label}" does not exist — creating it.`);
  const created = await fetchJson(`/custom-tags`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
  return { id: created.id, label: created.label };
}

async function toggleTag(tagId: string, emails: string[], assign: boolean): Promise<void> {
  await fetchJson(`/custom-tags/toggle-resource`, {
    method: "POST",
    body: JSON.stringify({
      tag_ids: [tagId],
      resource_type: 1, // 1 = accounts (2 = campaigns) — fixed 2026-10-20 after "NaN campaign(s) not found"
      resource_ids: emails,
      assign,
    }),
  });
}

async function main() {
  const args = process.argv.slice(2);
  const addArg = parseFlag(args, "--add") ?? parseFlag(args, "--add-tag");
  const removeArg = parseFlag(args, "--remove") ?? parseFlag(args, "--remove-tag");
  if (!addArg && !removeArg) {
    console.error("Provide --add=name and/or --remove=name");
    process.exit(1);
  }

  console.error(`Selecting inboxes...`);
  const inboxes = await selectInboxes(args);
  console.error(`Matched ${inboxes.length} inboxes`);
  if (!inboxes.length) return;

  const emails = inboxes.map((i) => i.email);

  console.error(`Actions: add=${addArg ?? "-"}  remove=${removeArg ?? "-"}`);
  console.error(`Proceeding in 3s... (Ctrl+C to abort)`);
  await new Promise((r) => setTimeout(r, 3000));

  if (addArg) {
    const tag = await ensureTag(addArg);
    await toggleTag(tag.id, emails, true);
    console.error(`Assigned tag "${tag.label}" to ${emails.length} accounts.`);
  }

  if (removeArg) {
    const tag = await findTagByLabel(removeArg);
    if (!tag) {
      console.error(`Tag "${removeArg}" does not exist — nothing to remove.`);
      process.exit(1);
    }
    await toggleTag(tag.id, emails, false);
    console.error(`Unassigned tag "${tag.label}" from ${emails.length} accounts.`);
  }

  console.error(`\nDone.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
