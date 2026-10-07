# linear-t3-relay

Delegate a Linear issue to an agent; [T3 Code](https://github.com/pingdotgg/t3code) does the work and reports back in the issue's Agent Session.

```
Linear ──AgentSessionEvent──▶ relay ──MCP──▶ T3 Code ──▶ commits + draft PR
   ▲                            │
   └── thoughts · actions · questions · answer · PR link
```

| In Linear | In T3 Code |
|---|---|
| Delegate an issue to the app | A thread starts, in a worktree on the issue's Linear branch (or in the project checkout) |
| Watch the session | Each finished tool call shows as an action |
| The agent asks something | An elicitation with selectable options; your reply is its answer |
| Reply in the session | The message goes to the same thread |
| Press **Stop** | The thread is interrupted |
| The agent opens a PR | The PR is attached to the issue as soon as `gh pr create` prints it |
| The run ends | The agent's final message is the session's response |

The relay talks to T3 Code only through its public outside-agent MCP server (`/mcp`, orchestration v2),
so it needs a T3 Code build from 2026-10-07 or later. It has no runtime dependencies beyond Node ≥ 22.13.

See [SPEC.md](SPEC.md) for the exact behaviour and [AGENTS.md](AGENTS.md) to work on the code.

## Setup

### 1. Public HTTPS

Linear must reach the relay. Put `HOST:PORT` behind a reverse proxy or a tunnel
(e.g. `tailscale funnel --bg --https=443 http://127.0.0.1:8787`) and use that origin as `BASE_URL`.
Only `/linear/*` and `/healthz` need to be public; T3 Code itself stays private.

### 2. Linear OAuth app

Linear → Settings → API → OAuth applications → New, in the workspace you want to serve:

- Redirect URI: `BASE_URL/linear/oauth/callback`
- Webhook URL: `BASE_URL/linear/webhook`, category **Agent session events**

Keep its client id, client secret and webhook signing secret for the environment below.

### 3. Environment

Copy `.env.example` to `.env` (or pass the variables some other way; `ENV_FILE` points at another file).

| Variable | |
|---|---|
| `BASE_URL`, `HOST`, `PORT` | Public origin, and where the relay listens |
| `INSTALL_SECRET` | Guards `/linear/install`; `openssl rand -hex 24` |
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` | From the OAuth app |
| `T3CODE_URL` | T3 Code server, e.g. `http://localhost:3773` |
| `T3CODE_RENEW_COMMAND` | **Relay on the T3 host:** a command printing a pairing code; the relay signs in and renews by itself |
| `T3CODE_TOKEN` | **Otherwise:** a bearer from `npm run t3:login`, valid 30 days |
| `T3CODE_MODEL` | `<provider-instance>/<model>`, e.g. `claudeAgent/claude-opus-5-5` |
| `T3CODE_MODEL_OPTIONS` | Optional JSON, e.g. `{"contextWindow":"1m"}` |
| `T3CODE_PROJECT` / `T3CODE_PROJECTS` | T3 project title for every issue, or a map by Linear project name (`"*"` = fallback) |
| `T3CODE_WORKSPACE` | `worktree` (default, one per issue) or `root` (the project checkout) |
| `ALLOWED_USER_IDS` | Comma-separated Linear user ids allowed to delegate or prompt; empty allows the whole workspace |
| `STATE_PATH`, `POLL_MS` | State file (keep it private and persistent) and T3 polling interval |

On the T3 host, the renew command is usually:

```sh
T3CODE_RENEW_COMMAND="t3 auth pairing create --json --ttl 5m --label linear-t3-relay --scope orchestration:read --scope orchestration:operate"
```

It must run as the user that owns the T3 Code data directory (add `--base-dir` if it is not the default).

### 4. Run and install

```sh
npm ci
npm start            # or: npm run build && node dist/server.js
```

Open `BASE_URL/linear/install?secret=$INSTALL_SECRET`, approve the app in the workspace, then delegate an issue to it.
One process serves one Linear workspace; run another instance (own env and state) for another workspace.

## Nix

The flake exposes `packages.default` and `homeManagerModules.default`, which runs one relay per
workspace as a launchd agent (macOS) or a systemd user service (Linux):

```nix
{
  inputs.linear-t3-relay = {
    url = "github:nSimonFR/linear-t3-relay";
    inputs.nixpkgs.follows = "nixpkgs";
  };
  # in a home-manager config:
  imports = [ inputs.linear-t3-relay.homeManagerModules.default ];
  services.linear-t3-relay = {
    enable = true;
    instances.personal = {
      port = 8787;
      environmentFile = config.age.secrets.linear-t3-relay-personal.path; # Linear app, BASE_URL, project…
      renewCommand = "${lib.getExe pkgs.t3code} auth pairing create --json --ttl 5m --scope orchestration:read --scope orchestration:operate";
    };
  };
}
```

`HOST`, `PORT`, `STATE_PATH`, `T3CODE_URL` and `T3CODE_RENEW_COMMAND` come from the module; everything
else comes from `environmentFile`. State lives in `$XDG_STATE_HOME/linear-t3-relay/<name>/`.

## Security

- Webhooks are HMAC-verified and must be under a minute old; the OAuth callback needs a one-time state.
- **Delegating runs code with full access on the T3 host.** Restrict who can with `ALLOWED_USER_IDS` in any shared workspace.
- Issue text is untrusted input to the agent, whoever delegated: a teammate's or customer's words can steer it.
  Run T3 Code under an account that holds only the credentials the work needs.
- Secrets live only in the environment and the state file (mode 600). Logs never print them.

## Development

```sh
npm test        # node:test, no network
npm run typecheck
```
