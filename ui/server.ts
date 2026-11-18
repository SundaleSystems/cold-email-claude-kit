#!/usr/bin/env tsx
/**
 * Outbound chat UI. Zero dependencies.
 *   npx tsx ui/server.ts            → http://localhost:8790
 *
 * Each agent is a Claude Code headless session (claude -p --output-format stream-json),
 * resumed by session id so the conversation keeps its memory. Tool calls stream to the
 * page as "Working" cards, Grok-style.
 */
import { createServer, IncomingMessage, ServerResponse } from "http";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { AGENTS, byId } from "./agents";

const ROOT = resolve(__dirname, "..");
const SESS_DIR = resolve(__dirname, "sessions");
const PORT = Number(process.env.PORT ?? 8790);
mkdirSync(SESS_DIR, { recursive: true });

type Msg = { role: "user" | "agent"; text: string; tools?: { name: string; detail: string }[]; ts: number };
type Session = { sessionId?: string; messages: Msg[] };

const sessPath = (agent: string) => resolve(SESS_DIR, `${agent}.json`);
const loadSession = (agent: string): Session => existsSync(sessPath(agent)) ? JSON.parse(readFileSync(sessPath(agent), "utf8")) : { messages: [] };
const saveSession = (agent: string, s: Session) => writeFileSync(sessPath(agent), JSON.stringify(s, null, 2));

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
}

function sidebarStatus(agentId: string): string {
  const a = byId(agentId);
  try {
    if (a?.statusFile) {
      const s = JSON.parse(readFileSync(resolve(ROOT, a.statusFile), "utf8"));
      const esc = (s.escalations ?? []).length;
      return `${s.date}: sent ${s.sent_last_send_day}/${s.target}, runway ${s.runway_days}d${esc ? `, ${esc} needs you` : ", all clear"}`;
    }
  } catch {}
  const sess = loadSession(agentId);
  const last = sess.messages[sess.messages.length - 1];
  return last ? last.text.replace(/\s+/g, " ").slice(0, 70) : a?.tagline ?? "";
}

const running = new Map<string, ReturnType<typeof spawn>>();

function chat(agentId: string, text: string, res: ServerResponse) {
  const agent = byId(agentId);
  if (!agent) return json(res, 404, { error: "unknown agent" });
  if (running.has(agentId)) return json(res, 409, { error: "agent is still working" });
  const sess = loadSession(agentId);
  sess.messages.push({ role: "user", text, ts: Date.now() });

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (ev: string, data: unknown) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
    "--append-system-prompt", agent.systemPrompt, "--max-turns", "40"];
  if (sess.sessionId) args.push("--resume", sess.sessionId);
  const child = spawn("claude", [...args, text], { cwd: ROOT, env: { ...process.env, CLAUDECODE: "" }, stdio: ["ignore", "pipe", "pipe"] });
  running.set(agentId, child);

  const reply: Msg = { role: "agent", text: "", tools: [], ts: Date.now() };
  let buf = "", stderr = "", doneSent = false;
  child.stdout!.on("data", (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: any; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "system" && ev.session_id) { sess.sessionId = ev.session_id; }
      if (ev.type === "assistant") {
        for (const block of ev.message?.content ?? []) {
          if (block.type === "text" && block.text) { reply.text += (reply.text ? "\n\n" : "") + block.text; send("text", { text: block.text }); }
          if (block.type === "tool_use") {
            const detail = block.name === "Bash" ? String(block.input?.description ?? block.input?.command ?? "").slice(0, 140)
              : block.name === "Read" ? String(block.input?.file_path ?? "").replace(ROOT + "/", "")
              : JSON.stringify(block.input ?? {}).slice(0, 140);
            reply.tools!.push({ name: block.name, detail });
            send("tool", { name: block.name, detail });
          }
        }
      }
      if (ev.type === "result") {
        if (ev.is_error && !reply.text) { reply.text = `Something went wrong: ${ev.result ?? ev.subtype ?? "unknown error"}`; send("text", { text: reply.text }); }
        doneSent = true; send("done", { cost: ev.total_cost_usd, turns: ev.num_turns, session: sess.sessionId });
      }
    }
  });
  child.stderr!.on("data", (c) => (stderr += c.toString()));
  child.on("close", (code) => {
    running.delete(agentId);
    if (!reply.text) { reply.text = code === 0 ? "(no reply)" : `Agent exited with code ${code}. ${stderr.slice(-400)}`; send("text", { text: reply.text }); }
    sess.messages.push(reply); saveSession(agentId, sess);
    if (!doneSent) send("done", { session: sess.sessionId });
    res.end();
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" }); return res.end(readFileSync(resolve(__dirname, "public/index.html")));
  }
  if (req.method === "GET" && url.pathname === "/api/agents") {
    return json(res, 200, AGENTS.map((a) => ({ id: a.id, name: a.name, tagline: a.tagline, color: a.color, color2: a.color2, status: sidebarStatus(a.id), busy: running.has(a.id),
      lastTs: loadSession(a.id).messages.slice(-1)[0]?.ts ?? null })));
  }
  const m = url.pathname.match(/^\/api\/agents\/([a-z-]+)\/(messages|chat|reset)$/);
  if (m) {
    const [, id, op] = m;
    if (op === "messages" && req.method === "GET") return json(res, 200, loadSession(id).messages);
    if (op === "reset" && req.method === "POST") { saveSession(id, { messages: [] }); return json(res, 200, { ok: true }); }
    if (op === "chat" && req.method === "POST") { const { text } = JSON.parse(await readBody(req) || "{}"); if (!text?.trim()) return json(res, 400, { error: "empty" }); return chat(id, text.trim(), res); }
  }
  json(res, 404, { error: "not found" });
}).listen(PORT, () => console.log(`Outbound UI → http://localhost:${PORT}`));
