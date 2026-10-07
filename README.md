# linear-t3-relay

Delegate a Linear issue to an agent; [T3 Code](https://github.com/pingdotgg/t3code) does the work in its own worktree and reports back in the issue's Agent Session.

```
Linear ──AgentSessionEvent──▶ relay ──MCP──▶ T3 Code ──▶ commits + draft PR
   ▲                            │
   └── thoughts / actions / questions / response / PR link
```

- **Delegate** an issue → a T3 thread starts on the issue's Linear branch name, in a fresh worktree.
- **Progress** → each finished tool call shows as an action in the session.
- **Questions** the agent asks → elicitations in Linear (one at a time, options selectable); your replies go back as its answers.
- **Follow-ups** in the session → sent to the same thread. **Stop** → interrupts it.
- **Done** → the agent's final message as the response, and the PR linked on the session.

It talks to T3 Code only through its public outside-agent MCP server (`/mcp`, orchestration v2),
which needs a T3 Code build from 2026-10-06 or later.

## Setup

1. `npm ci`, copy `.env.example` to `.env`.
2. Expose `HOST:PORT` over public HTTPS (reverse proxy, Tailscale Funnel, …) and set `BASE_URL`.
3. Create a Linear OAuth app: redirect `BASE_URL/linear/oauth/callback`, webhook `BASE_URL/linear/webhook`
   with **Agent session events**. Put its client id, secret and webhook signing secret in `.env`.
4. `npm run t3:login` (T3 Code running) and approve with **Full access**; the token lasts 30 days.
5. `npm start`, then open `BASE_URL/linear/install?secret=$INSTALL_SECRET` and approve the app.
6. Delegate an issue to the app.

Run it on the T3 Code host: the agent pushes and opens the PR with that machine's `git` and `gh`.

## Limits

- One thread per session; no planning stages, specs or sub-issues.
- Permission prompts are not relayed; threads run in full-access mode.
- State is a JSON file; run one process per state file.
