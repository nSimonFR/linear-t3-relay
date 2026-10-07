import { createHash, randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Store } from "./state.js";

const RENEW_BEFORE_MS = 5 * 86_400_000;
const DEFAULT_LIFETIME_MS = 30 * 86_400_000;
/** While the saved bearer still works, a failed renewal is retried at most this often. */
const RETRY_EARLY_RENEWAL_MS = 10 * 60_000;
// T3 only checks that the redirect is loopback; nothing listens there, the code is read from the decision reply.
const REDIRECT_URI = "http://127.0.0.1:1/callback";

const b64url = (buffer: Buffer) => buffer.toString("base64url");

async function json(fetcher: typeof fetch, url: string, init: RequestInit) {
  const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
  const body = await response.json() as Record<string, unknown>;
  // Never echo the body: a token response carries the credential.
  if (!response.ok) throw new Error(`T3 sign-in failed at ${new URL(url).pathname}: HTTP ${response.status}${typeof body.error === "string" ? ` ${body.error}` : ""}`);
  return body;
}

/**
 * Signs in to T3's MCP server as an outside agent with a pairing code instead of a
 * browser: register → decision (pairing code) → token. Returns a 30-day bearer.
 */
export async function signInWithPairingCode(base: string, pairingCode: string, fetcher: typeof fetch = fetch): Promise<{ token: string; expiresAt: number; issuedAt: number }> {
  const origin = base.replace(/\/$/, "");
  const resource = `${origin}/mcp`;
  const client = await json(fetcher, `${origin}/oauth/mcp/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Linear relay", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", grant_types: ["authorization_code"] }),
  });
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(16));
  const authorization = {
    response_type: "code", client_id: String(client.client_id), redirect_uri: REDIRECT_URI, state, resource,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
  };
  const decision = await json(fetcher, `${origin}/oauth/mcp/decision`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorization, decision: { _tag: "pairing-code", access: "full-access", code: pairingCode } }),
  });
  const redirect = new URL(String(decision.redirectTo));
  const code = redirect.searchParams.get("code");
  if (redirect.searchParams.get("state") !== state || !code) throw new Error(`T3 refused the sign-in: ${redirect.searchParams.get("error") ?? "no code"}`);
  const token = await json(fetcher, `${origin}/oauth/mcp/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: String(client.client_id), code_verifier: verifier, resource }),
  });
  if (typeof token.access_token !== "string") throw new Error("T3 sign-in returned no token.");
  const issuedAt = Date.now();
  const lifetime = Number(token.expires_in) > 0 ? Number(token.expires_in) * 1000 : DEFAULT_LIFETIME_MS;
  return { token: token.access_token, expiresAt: issuedAt + lifetime, issuedAt };
}

/** Runs the configured command and reads a pairing code from its JSON (`credential`) or plain output. */
export async function pairingCodeFrom(command: string, run = promisify(exec)): Promise<string> {
  const { stdout } = await run(command, { timeout: 30_000 });
  const text = stdout.trim();
  try { return String((JSON.parse(text) as { credential: string }).credential); }
  catch { return text.split(/\s+/).at(-1) ?? ""; }
}

/**
 * The T3 bearer the relay uses. With a renew command (the relay runs on the T3 host)
 * it signs in by itself and again five days before the 30-day expiry, or on a 401.
 */
export class T3Credential {
  private renewing: Promise<string> | undefined;
  private lastEarlyAttempt = 0;

  constructor(private readonly deps: {
    url: string; store: Store; staticToken?: string; renewCommand?: string;
    signIn?: typeof signInWithPairingCode; pairingCode?: (command: string) => Promise<string>;
    log?: (message: string) => void;
  }) {}

  async token(): Promise<string> {
    const saved = this.deps.store.state.t3;
    if (!this.deps.renewCommand) {
      if (!this.deps.staticToken) throw new Error("No T3CODE_TOKEN and no T3CODE_RENEW_COMMAND.");
      return this.deps.staticToken;
    }
    if (!saved || saved.expiresAt - 60_000 <= Date.now()) return this.renew();
    // Renew in the last fifth of the lifetime (five days for T3's 30), but never lose a working bearer to a failed renewal.
    const margin = Math.min(RENEW_BEFORE_MS, (saved.expiresAt - (saved.issuedAt ?? saved.expiresAt - DEFAULT_LIFETIME_MS)) / 5);
    if (saved.expiresAt - margin > Date.now() || Date.now() - this.lastEarlyAttempt < RETRY_EARLY_RENEWAL_MS) return saved.token;
    this.lastEarlyAttempt = Date.now();
    return this.renew().catch(error => {
      this.deps.log?.(`T3 renewal failed, keeping the current credential: ${error instanceof Error ? error.message : error}`);
      return saved.token;
    });
  }

  /** Called after a 401: the credential was revoked or expired early. */
  invalidate() {
    delete this.deps.store.state.t3;
    this.deps.store.save();
  }

  renew(): Promise<string> {
    this.renewing ??= (async () => {
      const code = await (this.deps.pairingCode ?? pairingCodeFrom)(this.deps.renewCommand!);
      const issued = await (this.deps.signIn ?? signInWithPairingCode)(this.deps.url, code);
      this.deps.store.state.t3 = issued;
      this.deps.store.save();
      this.deps.log?.(`T3 credential renewed; expires ${new Date(issued.expiresAt).toISOString()}`);
      return issued.token;
    })().finally(() => { this.renewing = undefined; });
    return this.renewing;
  }

  expiresAt(): number | undefined { return this.deps.renewCommand ? this.deps.store.state.t3?.expiresAt : undefined; }
}
