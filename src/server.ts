#!/usr/bin/env node
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { configFromEnv } from "./config.js";
import { Linear, verifySignature } from "./linear.js";
import { McpTransportError, T3CodeMcp } from "./mcp.js";
import { T3Credential } from "./t3-auth.js";
import { Relay, type AgentSessionEvent } from "./relay.js";
import { Store } from "./state.js";

const run = promisify(execFile);

/** Needs the relay on the T3 host; set T3CODE_BASE_REF otherwise. */
async function defaultBranch(cwd: string): Promise<string> {
  const head = await run("git", ["-C", cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => null);
  if (head) return head.stdout.trim().replace(/^origin\//, "");
  return (await run("git", ["-C", cwd, "branch", "--show-current"])).stdout.trim();
}

function body(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1_000_000) request.destroy(); else chunks.push(chunk); });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, text: string) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(`${text}\n`);
}

function main() {
  try { process.loadEnvFile(process.env.ENV_FILE ?? ".env"); } catch { /* environment only */ }
  const config = configFromEnv(process.env);
  const store = new Store(config.statePath);
  const linear = new Linear(config, store);
  const credential = new T3Credential({ url: config.t3Url, store, staticToken: config.t3Token, renewCommand: config.t3RenewCommand, log: console.log });
  const mcp = new T3CodeMcp(config.t3Url, () => credential.token());
  const t3 = {
    async call<T>(tool: string, args?: Record<string, unknown>): Promise<T> {
      try { return await mcp.call<T>(tool, args); }
      catch (error) {
        if (!(error instanceof McpTransportError && error.status === 401 && config.t3RenewCommand)) throw error;
        credential.invalidate();
        return mcp.call<T>(tool, args);
      }
    },
  };
  const relay = new Relay({ config, store, linear, t3, defaultBranch, log: console.error });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", config.baseUrl);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        const expiresAt = credential.expiresAt();
        // Only the date, so monitoring can warn before a manual T3CODE_TOKEN lapses; never the credential.
        return send(response, 200, expiresAt ? `ok; T3 credential expires ${new Date(expiresAt).toISOString()}` : "ok");
      }
      if (request.method === "GET" && url.pathname === "/linear/install") {
        const given = Buffer.from(url.searchParams.get("secret") ?? "");
        const expected = Buffer.from(config.installSecret);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(response, 401, "Invalid install secret.");
        response.writeHead(302, { location: linear.installUrl() }).end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/linear/oauth/callback") {
        await linear.completeInstall(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
        return send(response, 200, "Linear app installed. You can delegate issues to it now.");
      }
      if (request.method === "POST" && url.pathname === "/linear/webhook") {
        const raw = await body(request);
        if (!verifySignature(config.linearWebhookSecret, request.headers["linear-signature"] as string | undefined, raw)) return send(response, 401, "Invalid signature.");
        const event = JSON.parse(raw.toString("utf8")) as AgentSessionEvent & { webhookTimestamp?: number };
        if (typeof event.webhookTimestamp !== "number" || Math.abs(Date.now() - event.webhookTimestamp) > 60_000) return send(response, 401, "Stale webhook.");
        // Linear wants an answer within 5 seconds; the work happens after it.
        send(response, 200, "ok");
        if (event.type === "AgentSessionEvent") {
          void relay.acknowledge(event);
          void relay.enqueue(() => relay.handle(event));
        }
        return;
      }
      send(response, 404, "Not found.");
    } catch (error) {
      console.error(error);
      if (!response.headersSent) send(response, 500, "Internal error.");
    }
  });
  server.listen(config.port, config.host, () => console.log(`linear-t3-relay listening on ${config.host}:${config.port}; install: ${config.baseUrl}/linear/install?secret=…`));

  // Renew ahead of expiry even when idle, so the first webhook after a quiet week is not the one to pay for it.
  if (config.t3RenewCommand) setInterval(() => void credential.token().catch(error => console.error(`T3 renewal failed: ${error.message}`)), 6 * 3_600_000).unref();

  const tick = () => relay.enqueue(() => relay.poll()).finally(() => setTimeout(tick, config.pollMs));
  void tick();
}

main();
