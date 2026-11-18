// Anthropic API helper. Two models, one drafting and one grading,
// called separately so the verifier never sees the drafter's reasoning.
import { config } from "./config.ts";

export async function callClaude(args: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        max_tokens: args.maxTokens ?? 1200,
        system: args.system,
        messages: [{ role: "user", content: args.user }],
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      continue;
    }
    throw new Error(`anthropic ${args.model} → ${res.status}: ${await res.text()}`);
  }
}

/**
 * Call the model and parse its JSON, retrying once if it comes back
 * unusable.
 *
 * Two observed failure modes, together roughly one reply in eight:
 * a long-winded response hits max_tokens and the JSON is cut off before
 * its closing brace, or prose inside a string field (evidence, reasoning)
 * contains an unescaped quote. Left alone either throws out of the
 * pipeline and the lead gets no draft at all, so it is worth one more
 * call — with double the token budget, since truncation is the common
 * case, and an instruction to be brief and escape properly.
 */
export async function callClaudeJson<T>(args: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  label: string; // "classifier" / "verifier", for the error message
}): Promise<T> {
  const raw = await callClaude(args);
  try {
    return parseJson<T>(raw);
  } catch (first) {
    const retry = await callClaude({
      ...args,
      maxTokens: (args.maxTokens ?? 1200) * 2,
      user: `${args.user}

Your previous response could not be parsed as JSON (${String(first).slice(0, 150)}).
Return ONE complete, valid JSON object and nothing else. Keep every string
field brief so the object fits well within the response limit, escape every
double quote inside a string value as \\", and never put a raw line break
inside a string value.`,
    });
    try {
      return parseJson<T>(retry);
    } catch (second) {
      throw new Error(`${args.label} returned unparseable JSON twice: ${String(second).slice(0, 200)}`);
    }
  }
}

/** Extract the first JSON object from a model response, tolerantly. */
export function parseJson<T>(text: string): T {
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON object in model output: ${text.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}
