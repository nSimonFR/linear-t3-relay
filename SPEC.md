# Behaviour

What the relay guarantees. Change this file with the code that changes the behaviour.

## Sessions

- One Linear Agent Session ↔ one T3 Code thread, stored in the state file (`sessions[linearSessionId]`).
- Webhook deliveries are de-duplicated by `action:sessionId:activityId`; a Linear retry does nothing.
- Webhooks and polls run on one queue, so a session's state is never updated concurrently.

## Delegation (`created`)

1. Within Linear's 10-second limit, post a `thought` ("Starting a T3 Code thread…").
2. If `ALLOWED_USER_IDS` is set and the session's creator is not in it, post an `error` and stop.
3. Resolve the issue; pick the T3 project from `T3CODE_PROJECTS[<Linear project name>]`, else `"*"`;
   no match is an `error` in the session, never a guess.
4. `t3_thread_launch` with the issue prompt (identifier, title, URL, Linear's `promptContext`, instructions to
   test, push and open a draft PR mentioning the identifier, and to ask instead of guessing):
   - `worktree`: a new worktree on the issue's Linear `branchName`, from the repository's default branch.
   - `root`: the project's own checkout.
5. Post an `action` "Started T3 Code thread".

## Follow-ups (`prompted`)

- The author must be allowed (same rule as delegation).
- `stop` signal → `t3_thread_interrupt`, a final `response` "Stopped", nothing more until the next prompt.
- A pending question → the reply answers the current question (see Questions); otherwise
  `t3_thread_send` to the same thread with `clientRequestId` = the Linear activity id (idempotent).
- A prompt for an unknown session starts one, as a delegation would.

## Polling

Every `POLL_MS`, for each session waiting on a run or a question, read the thread timeline after the
last reported position:

- Each **finished** item, in order, once: tool and command items become ephemeral `action`s,
  `error` items become `error`s; messages, reasoning and checkpoints are not mirrored.
- A PR URL — in a command's output, in the thread's linked PR, or in the final reply — is attached to the
  issue (`attachmentLinkGitHubPR`, else `attachmentLinkURL`) and to the session's external URLs, once per URL.
- When the awaited run ends: `completed` → the last assistant message, untruncated, as the `response`;
  `failed` → an `error`; `interrupted` → nothing (Stop already answered).

## Questions

- A pending T3 user-input request becomes Linear `elicitation`s, one question at a time, with the options
  as a `select` signal.
- A reply picks an option by letter (`B`), number (`2`) or label, comma-separated when multi-select;
  anything else is a free-text answer. After the last question the answers go back with
  `t3_pending_request_respond`.
- Permission prompts are not relayed: threads run in `full-access`.

## Credentials

- **Linear**: OAuth `actor=app` install; the token is refreshed five minutes before expiry and stored in the state.
- **T3**: with `T3CODE_RENEW_COMMAND`, the relay runs it to get a pairing code, signs in headlessly
  (register → `/oauth/mcp/decision` with the code → token) and keeps the 30-day bearer in the state. It
  renews five days before expiry (checked every 6 hours and before each call) and immediately after a 401.
  With `T3CODE_TOKEN` it uses that bearer as-is.
- No credential is ever written to logs, HTTP responses or error messages.

## HTTP

| Route | |
|---|---|
| `POST /linear/webhook` | HMAC-SHA256 of the raw body (`linear-signature`), `webhookTimestamp` within 60 s; answered 200 before any work |
| `GET /linear/install?secret=` | Constant-time secret check, then redirect to Linear's consent page |
| `GET /linear/oauth/callback` | One-time state (10 min), code exchange |
| `GET /healthz` | `ok`, plus the T3 credential's expiry date when the relay manages it |

Any other failure answers a generic 500.
