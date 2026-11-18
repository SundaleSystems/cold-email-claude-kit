#!/usr/bin/env tsx
/**
 * Bulk apply signatures to Instantly sending accounts.
 *
 * Default signature template:
 *   <sender_first_name> <sender_last_name>
 *   <sender_title>
 *   <sender_company_name>
 *   <sender_physical_address>
 *
 * Keeping a real mailing address in the signature is recommended — it's standard practice and covers CAN-SPAM-style rules.
 *
 * Sender identity comes from .env:
 *   SENDER_FIRST_NAME
 *   SENDER_LAST_NAME
 *   SENDER_TITLE
 *   SENDER_COMPANY_NAME
 *   SENDER_PHYSICAL_ADDRESS
 *
 * Per-inbox overrides (preferred when each inbox should look like a different person):
 *   If the account has `first_name` / `last_name` set (e.g. "Jane" "Smith"), the script
 *   uses those instead of SENDER_FIRST_NAME + SENDER_LAST_NAME.
 *
 * Instantly signatures are HTML — template newlines are converted to <br> tags
 * before uploading. Instantly appends the account signature automatically to
 * campaign emails, so set it once per account here (no placeholder needed in copy).
 *
 * Usage:
 *   export INSTANTLY_API_KEY=xxx
 *   export SENDER_TITLE="Founder" SENDER_COMPANY_NAME="Acme" ...
 *   npx tsx scripts/set-signatures.ts --all
 *   npx tsx scripts/set-signatures.ts --tag=active
 *
 *   # Override the default template entirely:
 *   npx tsx scripts/set-signatures.ts --all --template="Cheers,\n{from_name}\n{title}\n{company}"
 *   npx tsx scripts/set-signatures.ts --all --template-file=./my-signature.txt
 *
 * Supported placeholders in custom templates:
 *   {from_name}   — account's `first_name` + `last_name`, or SENDER_FIRST_NAME + SENDER_LAST_NAME fallback
 *   {from_email}  — the account's sending address
 *   {domain}      — domain part of the email
 *   {title}       — SENDER_TITLE
 *   {company}     — SENDER_COMPANY_NAME
 *   {address}     — SENDER_PHYSICAL_ADDRESS
 */

import { readFileSync } from "fs";
import { parseFlag, selectInboxes, runWithConcurrency, fetchJson, InboxAccount } from "./_lib";

const DEFAULT_TEMPLATE = "{from_name}\n{title}\n{company}\n{address}";

function envOrThrow(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v && v.trim()) return v.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(
    `Missing env: ${key}. Set it in .env — required for the default signature template.`
  );
}

function renderSignature(
  inbox: InboxAccount,
  template: string,
  senderFullName: string,
  title: string,
  company: string,
  address: string
): string {
  const email = inbox.email || "";
  const domain = email.split("@")[1] || "";
  // Prefer the account's own first_name + last_name (if each inbox represents a
  // different persona), fall back to SENDER_FIRST_NAME + SENDER_LAST_NAME from env.
  const accountName = [inbox.first_name, inbox.last_name]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const fromName = accountName || senderFullName;
  const text = template
    .replace(/\{from_name\}/g, fromName)
    .replace(/\{from_email\}/g, email)
    .replace(/\{domain\}/g, domain)
    .replace(/\{title\}/g, title)
    .replace(/\{company\}/g, company)
    .replace(/\{address\}/g, address)
    .replace(/\\n/g, "\n");
  // Instantly's signature field is HTML — join template lines with <br>.
  return text.split(/\r?\n/).join("<br>");
}

async function main() {
  const args = process.argv.slice(2);
  const templateFile = parseFlag(args, "--template-file");
  const templateArg = parseFlag(args, "--template");
  const template = templateFile
    ? readFileSync(templateFile, "utf8")
    : templateArg ?? DEFAULT_TEMPLATE;

  // Read sender identity from env (required for the default template).
  // For custom templates that don't use these placeholders, missing vars are OK.
  const usesTitle = /\{title\}/.test(template);
  const usesCompany = /\{company\}/.test(template);
  const usesAddress = /\{address\}/.test(template);
  const usesFromName = /\{from_name\}/.test(template);

  const firstName = usesFromName ? envOrThrow("SENDER_FIRST_NAME", "") : "";
  const lastName = usesFromName ? envOrThrow("SENDER_LAST_NAME", "") : "";
  const title = usesTitle ? envOrThrow("SENDER_TITLE") : "";
  const company = usesCompany ? envOrThrow("SENDER_COMPANY_NAME") : "";
  const address = usesAddress ? envOrThrow("SENDER_PHYSICAL_ADDRESS") : "";
  const senderFullName = [firstName, lastName].filter(Boolean).join(" ");

  console.error(`Selecting inboxes...`);
  const inboxes = await selectInboxes(args);
  console.error(`Matched ${inboxes.length} inboxes`);
  if (!inboxes.length) return;

  const sample = renderSignature(inboxes[0], template, senderFullName, title, company, address);
  console.error(
    `\nSample signature (HTML) that will be applied to ${inboxes[0].email}:\n---\n${sample}\n---`
  );
  console.error(`\nApplying to ${inboxes.length} inboxes in 5s... (Ctrl+C to abort)`);
  await new Promise((r) => setTimeout(r, 5000));

  let ok = 0;
  let fail = 0;
  await runWithConcurrency(inboxes, 5, async (inbox, i) => {
    const signature = renderSignature(inbox, template, senderFullName, title, company, address);
    try {
      await fetchJson(`/accounts/${encodeURIComponent(inbox.email)}`, {
        method: "PATCH",
        body: JSON.stringify({ signature }),
      });
      ok++;
      if ((i + 1) % 20 === 0) console.error(`  ${i + 1}/${inboxes.length} processed`);
    } catch (err) {
      fail++;
      console.error(`  [${inbox.email}] ${String(err).slice(0, 200)}`);
    }
  });

  console.error(`\nDone. ${ok} updated, ${fail} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
