# Outbound UI

A Grok-style chat window for talking to the outbound agents. Each agent is a Claude Code
headless session running in this repo, so it has the skills, scripts, `.env`-backed API
access, and memory. Conversations persist per agent in `ui/sessions/`.

```bash
npx tsx ui/server.ts        # then open http://localhost:8790
```

Agents are defined in `ui/agents.ts` (name, colour, system prompt). Add one by adding an entry.

| Agent | What it can do from the chat |
|---|---|
| Account Manager | Live send counts, runway, why a campaign is paused, run the daily check, resume or pause campaigns, add leads from a list |
| Reply Gate | List unanswered replies, draft one in the operator's style, send it when told, edit offer sheets, flip a campaign live or back to shadow, report what the gate did today |

Rules the agents follow: nothing outward-facing (sending, activating, spending, secrets) without you
asking for it in the conversation, and every number comes from a script they just ran.

The "Run daily check" button sends the real daily run to the Account Manager. "reset" in the
header starts a fresh conversation with that agent.

Keep the terminal running; close it to stop the UI. To have it start with your Mac, add a launchd
plist like the ones in `account-manager/launchd/` pointing at `npx tsx ui/server.ts`.
