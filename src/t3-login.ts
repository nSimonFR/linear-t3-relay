#!/usr/bin/env node
try { process.loadEnvFile(".env"); } catch { /* no .env yet */ }
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Signs the bridge in to T3Code's MCP server as an outside agent (OAuth 2.1 + PKCE)
 * and saves the 30-day bearer to .env as T3CODE_TOKEN. Approve with "Full access".
 */
const base = (process.argv[2] ?? process.env.T3CODE_URL ?? "http://localhost:3773").replace(/\/$/, "");
const b64url = (buffer: Buffer) => buffer.toString("base64url");

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const server = createServer();
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

const metadata = await json(`${base}/.well-known/oauth-authorization-server`);
const client = await json(String(metadata.registration_endpoint), {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Linear relay", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code"] }),
});
const verifier = b64url(randomBytes(48));
const state = b64url(randomBytes(16));
const authorize = new URL(String(metadata.authorization_endpoint));
for (const [key, value] of Object.entries({
  response_type: "code", client_id: String(client.client_id), redirect_uri: redirectUri, state,
  code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
  resource: `${base}/mcp`, scope: "orchestration:read orchestration:operate",
})) authorize.searchParams.set(key, value);

console.log(`Open and approve with "Full access":\n\n${authorize}\n`);
const code = await new Promise<string>((resolve, reject) => server.on("request", (request, response) => {
  const url = new URL(request.url ?? "/", redirectUri);
  if (url.pathname !== "/callback") { response.writeHead(404).end(); return; }
  const error = url.searchParams.get("error");
  response.writeHead(200, { "content-type": "text/plain" }).end(error ? `Sign-in failed: ${error}` : "Signed in. You can close this tab.");
  if (url.searchParams.get("state") !== state) reject(new Error("OAuth state mismatch."));
  else if (error) reject(new Error(`Sign-in failed: ${error}`));
  else resolve(url.searchParams.get("code") ?? "");
}));
server.close();

const token = await json(String(metadata.token_endpoint), {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: String(client.client_id), code_verifier: verifier, resource: `${base}/mcp` }),
});
if (!String(token.scope ?? "").includes("orchestration:operate")) console.warn("Warning: approved read-only; the bridge needs Full access to start threads.");

let env = "";
try { env = await readFile(".env", "utf8"); } catch { /* first run */ }
for (const [key, value] of [["T3CODE_URL", base], ["T3CODE_TOKEN", String(token.access_token)]]) {
  const line = `${key}=${value}`;
  env = new RegExp(`^${key}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`;
}
await writeFile(".env", env, { mode: 0o600 });
console.log(`Saved T3CODE_URL and T3CODE_TOKEN to .env (expires in ${Math.round(Number(token.expires_in) / 86400)} days).`);
