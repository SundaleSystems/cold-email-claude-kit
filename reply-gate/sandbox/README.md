# The Reply Gate sandbox

Two ways to find out what the system would say to a prospect, neither of
which sends anything.

## 1. Manual tester — send a reply, read the answer

```bash
cd reply-gate
deno run -A sandbox/serve.ts
```

It opens `http://localhost:8787`. Set the lead's first name, company and
website at the top (they are remembered between messages), paste what the
prospect wrote, and hit send. Cmd+Enter works too.

Roughly twenty seconds later you get the verdict — `WOULD SEND`, `HELD` or
`SKIPPED` — the bucket it picked, the reply in full, and, when it stops
itself, the reason. Each send stacks on the page so you can compare.

Things worth trying: leave the first name blank (the greeting degrades to a
bare "Hi"); paste a reply with our own email quoted underneath; send their
Calendly link; ask the price.

```bash
deno run -A sandbox/serve.ts --port 9000 --no-open
```

## 2. Batch runner — a file of replies at once

```bash
deno run -A sandbox/run.ts
open sandbox/out/report.html
```

Runs every case in `cases/default.md` (33 of them, covering each bucket and
each trap) and writes an HTML and a markdown report. Use it as a regression
check after changing the offer sheet or a template.

```bash
deno run -A sandbox/run.ts --cases cases/mine.md   # a different case file
deno run -A sandbox/run.ts --only price            # cases whose name contains "price"
deno run -A sandbox/run.ts --reply "how much?"     # one ad-hoc reply
deno run -A sandbox/run.ts --fake-slots            # fixed times, no Calendly call
deno run -A sandbox/run.ts --concurrency 8         # default 4
```

### Writing cases

```markdown
## A name for this case
@first_name: Sean
@company: Acme Plumbing
@website: acmeplumbing.example
@email: sean@acmeplumbing.example
@expect: positive_interested
Sounds great, let's do it. When are you free?
```

Everything after the `@` lines, up to the next `##`, is the reply body
verbatim — paste real replies straight in, quoted thread and all.

| Key | Default | Why it matters |
|---|---|---|
| `@first_name` | none | Drives the greeting; without it the reply opens with a bare "Hi" |
| `@company` / `@website` | none | The business-noun check allows a generic noun only if it appears here |
| `@email` | derived from the name | Cosmetic |
| `@subject` | `Re: quick question` | The noise filter reads it |
| `@auto_reply` | `false` | `true` simulates Instantly's auto-reply flag |
| `@offer` | first non-global sheet | Which offer sheet to use |
| `@expect` | none | A bucket name, or `held` / `skipped`. Scored ✓/✗ in the summary |
| `@note` | none | A comment to yourself |

## What is real and what is not

**Real** — the parts that decide what a prospect receives:

- the noise filter (OOO / bounce / unsubscribe) and quote stripping
- the do-not-reply rule for prospects who send their own calendar link
- the classifier, calling Claude with the same prompt production uses
- the reply templates, assembled by the same code
- the deterministic checks (price leaks, business nouns, em-dashes, links, sign-off, greeting)
- the verifier model, with the same five criteria
- the retry-once-on-failure logic and the 0.8 confidence threshold
- your real Calendly free slots

**Faked** — the parts that only fetch or store:

- the reply and the lead (from the page or your case file, not Instantly)
- the offer sheet (read from `data/offer-sheets.json`)
- the campaign lookup

**Never happens** — no email is sent, no `replies_log` row is written, no
Slack message is posted, no Instantly request is made. `db.ts`,
`instantly.ts`, `slack.ts` and `sender.ts` are not even imported, and the
Supabase credentials are deliberately replaced with junk.

`WOULD SEND` means every gate passed. In production right now that reply
still would not go out, because `SHADOW_MODE=true` and the campaign is
`live=false` — it would land in Slack as a shadow draft instead.

## Giving feedback on a reply

Every result card in the manual tester has a feedback strip. Pick a verdict
— Good / Wrong wording / Wrong bucket / Should have held / Should have
replied — and, when it got it wrong, paste **the reply you would actually
have sent**. Hitting "Good" with an empty box saves immediately.

Each save appends one JSON line to `sandbox/out/feedback.jsonl` carrying
everything needed to act on it without reconstructing anything: the offer
sheet used, the prospect's reply, the lead fields, the bucket and
confidence, the body the gate produced, the hold reason, and your ideal
version.

```bash
# what has been logged so far
python3 -c "import json;[print(json.loads(l)['verdict'],'|',json.loads(l)['offer'],'|',json.loads(l)['prospect_reply'][:60]) for l in open('sandbox/out/feedback.jsonl') if l.strip()]"
```

The ideal-reply box is the one that matters. `ideal_replies` on the offer
sheet controls wording more than any rule in the prompt, so a corrected
reply goes almost straight onto the sheet. Fix the **sheet**, not the
draft — same principle as the shadow period in the main README.

Feedback maps to fixes roughly like this:

| Verdict | Usually fixed by |
|---|---|
| Wrong wording | `ideal_replies`, `voice_rules`, `banned_phrases` |
| Wrong bucket | the bucket descriptions in `classifyReply` (code) |
| Should have held | a missing fact in `offer_facts`, or a tighter `business_noun` |
| Should have replied | a fact the sheet was missing, so the verifier called it ungrounded |
| Recurring objection | a `common_questions` entry |

Once a case is fixed, add it to `cases/default.md` with an `@expect` so it
becomes a permanent regression test, then re-run the batch runner.

## Tuning the copy

1. `deno run -A sandbox/pull.ts` — refresh `data/offer-sheets.json` from
   Supabase, read-only, via the Management API and your
   `SUPABASE_ACCESS_TOKEN`.
2. Edit `data/offer-sheets.json` directly: `high_level_answer`,
   `pricing_facts`, `ideal_replies`, `common_questions`, `voice_rules`,
   `banned_phrases`. The manual tester re-reads the file on every send, so
   you can edit and re-send without restarting.
3. When a version is right, put it into the `knowledge_base` table in the
   Supabase dashboard. There is deliberately no push script — the live
   sheet should only ever change by a decision you made on purpose.

The reply bodies themselves live in code
(`supabase/functions/reply-gate/drafter.ts`, `assembleReply`). Changing the
wording of a template means editing that function and redeploying; the offer
sheet only fills in its blanks.

## Cost

Two Claude calls per reply, three or four if the gate fails and it retries.
The full 33-case file is a few cents of Sonnet.

## Keeping it honest

`sandbox/lib/engine.ts` mirrors the gate order in
`supabase/functions/reply-gate/pipeline.ts`. It is a separate file so the
deployed function stays untouched, which means the two can drift: if you add
or reorder a gate in `pipeline.ts`, make the same change in `runReply()`.

`tests/smoke.ts` covers the deterministic layers with no network at all —
run that first if a template looks wrong (it needs the required secrets to
exist, but any dummy value will do):

```bash
deno run --allow-read --allow-env tests/smoke.ts
```
