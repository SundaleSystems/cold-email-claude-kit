---
name: instantly-spintax
description: Adds Instantly-compatible spintax to cold email sequences for deliverability. Use this skill whenever the user asks to add spintax, spin text, add variations, or improve deliverability of email copy — especially when they mention Instantly, Instantly.ai, cold email sequences, or paste HTML email content. Also trigger when the user says "spintax", "spin", "variations", "deliverability spintax", or references adding randomized alternatives to email copy. Works with both plain text and HTML input.
---

# Instantly Spintax Skill

Add deliverability-improving spintax to cold email sequences using Instantly.ai's syntax, without changing the meaning or tone of the original messaging.

## Core Concept

Spintax lets Instantly randomly pick one option per send, so no two emails are identical. This reduces pattern detection by spam filters and improves deliverability.

**Instantly syntax:** `{{RANDOM | option1 | option2 | option3}}`

Double curly braces, the literal keyword `RANDOM` first, then each option separated by a pipe `|`. Instantly picks one option at random per email send. Spintax works in both the **email body** and **subject lines**.

---

## Input Handling

### HTML Input (preferred workflow)

Users often paste HTML from Instantly because copy-pasting plain text loses formatting (spaces, line breaks). When the user provides HTML:

1. Mentally parse the text content from the HTML
2. Add spintax to the text content
3. Return the full HTML with spintax baked in, preserving all HTML tags, `<br>`, `<div>`, structure exactly as received
4. Output as a code block so the user can copy-paste straight back into Instantly

### Plain Text Input

If the user pastes plain text, add spintax and return plain text.

---

## The Golden Rule: No Broken Combinations

Every possible combination that Instantly could randomly assemble MUST read as a natural, grammatically correct, complete sentence. This is the single most important rule.

### What "broken combo" means

When spintax options are placed near each other, every possible pairing across adjacent spintax blocks must work together. If option A from block 1 combines with option B from block 2 to form a weird or ungrammatical sentence, that's a broken combo.

### How to prevent broken combos

**Make each spintax block a self-contained phrase.** The options within one block should be interchangeable without depending on what another nearby block picks.

**BAD — dependent blocks that can break:**
```
{{RANDOM | let me know if | would}} {{employeeLine}} {{RANDOM | would be better to speak to | be a better person to chat with}}
```
Problem: "would" + "would be better to speak to" = "would {{employeeLine}} would be better to speak to" — broken.

**GOOD — each option is a full standalone phrase:**
```
{{RANDOM | let me know if {{employeeLine}} would be better to speak to about this? | would {{employeeLine}} be a better person to chat with about this? | should I be reaching out to {{employeeLine}} about this instead?}}
```
Each option is a complete sentence on its own. No cross-block dependency. Instantly supports variables nested inside spintax options — this is valid and useful.

### Verification step

After adding spintax, mentally walk through every combination across adjacent blocks. If any pairing sounds off, restructure so each block is independent. When the sentence structure makes independent blocks risky, wrap the entire sentence in one spintax block with full sentence alternatives.

---

## Variable Fallbacks vs Spintax — Don't Confuse Them

Instantly uses the **same double-brace pipe syntax** for two different features. The first token inside the braces determines which one you get:

- `{{RANDOM | Hey | Hi}}` — first token is the literal keyword `RANDOM` → **spintax**. Instantly picks one option at random.
- `{{firstName | there}}` — first token is a variable name → **fallback**. Instantly renders the variable's value, and only shows "there" if the variable is empty for that lead.
- `{{firstName | lastName | for you}}` — fallbacks chain: tries `firstName`, then `lastName`, then renders "for you" if both are empty.

**Rules that follow from this:**

1. **Never start a spintax block with anything other than the literal `RANDOM`.** If the first token happens to match a variable name, Instantly treats the whole block as a fallback chain, not a spin — silently producing the wrong output.
2. **Don't "fix" fallback blocks by adding RANDOM.** `{{firstName | there}}` is intentional fallback logic — leave it exactly as-is.
3. **Fallbacks are a deliverability-friendly companion to spintax.** If the copy greets with a bare `{{firstName}}` and the user's list has gaps, suggest `{{firstName | there}}` as a flag (see Flagging Issues) — but don't change it unprompted.

---

## What to Spin

Add 2-3 options per spintax block. Target these elements:

### Always spin
- **Greetings:** `{{RANDOM | Hey | Hi}}` — simple, always safe
- **Opt-out / unsubscribe lines:** These are repetitive across emails and easy to spin without tone change
- **CTAs:** Different phrasings of the same ask
- **Transition words and connectors:** "just", "also", "actually", etc.

### Spin when natural
- **Verb choices:** `{{RANDOM | help | work with}}`, `{{RANDOM | built | made}}`, `{{RANDOM | handles | manages | tackles}}`
- **Descriptors:** `{{RANDOM | completely free | on us | 100% free}}`
- **Sentence-level rephrasings:** When a line can be said 2-3 different ways without changing meaning
- **Subject lines:** Instantly supports spintax in subjects — spinning them is one of the highest-leverage deliverability moves

### Never spin
- **Instantly variables:** `{{firstName}}`, `{{companyName}}`, and any custom variables — leave these exactly as-is. Variable names are **case-sensitive** and must exactly match the CSV column headers the leads were uploaded with (Instantly defaults are camelCase: `firstName`, `lastName`, `companyName`).
- **Existing fallback blocks:** `{{firstName | there}}` — that's fallback logic, not spintax (see above). Never touch.
- **Specific data points:** Numbers, stats, brand names, product names, pricing
- **Technical terms or product descriptions** that need to be precise

---

## Tone Preservation

The spintax options must match the tone and register of the original. If the original is casual, all options should be casual. If it's direct, keep all options direct. Don't introduce formality where there was none, and don't add slang where the original was professional.

**Original tone: casual/direct**
- ✅ `{{RANDOM | Worth a shot? | Want to give it a try? | Open to trying it out?}}`
- ❌ `{{RANDOM | Would you be amenable to a trial? | Worth a shot?}}` — register mismatch

---

## Output Format

### For HTML input
Return the spintaxed HTML inside a code block:

```html
{{RANDOM | Hey | Hi}} {{firstName}}, {{RANDOM | open to a free backlink on | interested in a free backlink from}} Forbes, WSJ, or Tech Times for {{companyName}}?
<br>
<br>{{RANDOM | We work with | We partner with}} a network of over 1,200 publishers...
```

### For plain text input
Return the spintaxed text inside a code block:

```
{{RANDOM | Hey | Hi}} {{firstName}}, {{RANDOM | open to a free backlink on | interested in a free backlink from}} Forbes, WSJ, or Tech Times for {{companyName}}?
```

### After each email
State: "All combos clean." — confirming you verified every combination. If you found and fixed something, note what you changed and why.

Then ask: "Next?" or "Drop the next one." to keep the flow moving.

---

## Multi-Email Sequences

When the user is doing a full sequence, process one email at a time. After each:
1. Output the spintaxed version
2. Confirm combos are clean
3. Prompt for the next email

Keep a mental count of which email in the sequence you're on (Email 1, Email 2, etc.) so you can reference them if the user asks.

---

## Flagging Issues

If you spot something in the original copy that's awkward or could be improved (independent of spintax), flag it briefly after the spintax output. For example:

> One small flag: "does QA differently" reads a bit awkward — consider swapping to `{{RANDOM | handles | approaches | tackles}}` instead.

Keep flags minimal. Only flag things that would actually hurt the email's performance. Don't rewrite their copy unless asked.

---

## Quick Reference

| Element | Example |
|---|---|
| Syntax | `{{RANDOM \| option1 \| option2 \| option3}}` |
| Greeting | `{{RANDOM \| Hey \| Hi}}` |
| Verb swap | `{{RANDOM \| help \| work with \| partner with}}` |
| Full sentence | `{{RANDOM \| Is this worth exploring? \| Want to give it a try? \| Open to a quick chat?}}` |
| Opt-out | `{{RANDOM \| If this isn't relevant, just reply and I won't follow up. \| Not relevant? Just reply and I won't reach out again.}}` |
| Variable fallback (not spintax) | `{{firstName \| there}}` — renders "there" when firstName is empty |
| Never touch | `{{firstName}}`, `{{companyName}}`, custom variables, existing fallback blocks |

---

## What to do next

**Launch the spintaxed copy in Instantly** — paste it into the campaign editor (subject and body both accept spintax), or follow `/cold-email-starter-kit`'s Instantly path if setting up the campaign from scratch. **Always use Instantly's email preview before launching** to confirm every spintax block renders correctly (Instantly's own docs recommend previewing to test spintax and variable mapping).

**Or wait:** skip this skill until your copy is final. Spintax complicates later debugging.

## Related skills

- `/campaign-copywriting` — writes the base copy this skill varies
- `/spam-word-checker` — QA the copy for spam triggers before adding spintax
- `/cold-email-starter-kit` — end-to-end guide including Instantly campaign upload
