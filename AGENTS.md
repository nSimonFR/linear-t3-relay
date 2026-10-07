# Working on linear-t3-relay

Behaviour is specified in [SPEC.md](SPEC.md); update it in the same change as the code.

## Layout

| File | |
|---|---|
| `src/relay.ts` | The whole flow: webhook handling, polling, questions, PR attachment. Talks to `LinearApi` and `T3Api` only |
| `src/linear.ts` | Linear OAuth, GraphQL, webhook signature |
| `src/mcp.ts` | Minimal MCP client for T3's `/mcp` (streamable HTTP) |
| `src/t3-auth.ts` | T3 bearer: headless sign-in with a pairing code and renewal |
| `src/t3-login.ts` | Interactive browser sign-in for a remote T3 (`npm run t3:login`) |
| `src/server.ts` | HTTP routes and wiring; the only file that reads the environment |
| `src/config.ts`, `src/state.ts` | Environment parsing; the JSON state file |

## Rules

- No runtime dependencies. Node built-ins only; `tsx`/`typescript` are dev-only.
- Every I/O goes through an injected seam (`LinearApi`, `T3Api`, `fetcher`, `run`) so tests need no network.
- Never log, return or throw a credential. Error messages name the step, never echo a response body.
- T3 is reached only through its documented MCP tools; do not use its internal WebSocket/HTTP APIs.
- Keep comments to constraints the code cannot show.

## Checks

```sh
npm test && npm run typecheck && npm run build
```

Live testing: run against a real T3 (`T3CODE_URL`) with a fake `LinearApi` that prints activities, before
pointing a Linear workspace at it.
