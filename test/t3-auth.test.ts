import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pairingCodeFrom, signInWithPairingCode, T3Credential } from "../src/t3-auth.js";
import { Store } from "../src/state.js";

test("signs in with a pairing code, without a browser", async () => {
  const requests: Array<{ path: string; body: any }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(String(init.body)));
    requests.push({ path: pathname, body });
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (pathname === "/oauth/mcp/register") return reply({ client_id: "client-1" });
    if (pathname === "/oauth/mcp/decision") return reply({ redirectTo: `http://127.0.0.1:1/callback?code=abc&state=${body.authorization.state}` });
    if (pathname === "/oauth/mcp/token") return reply({ access_token: "bearer-1", expires_in: 2_592_000 });
    return reply({}, 404);
  }) as typeof fetch;
  const issued = await signInWithPairingCode("http://t3:3773/", "PAIR123", fetcher);
  assert.equal(issued.token, "bearer-1");
  assert.ok(issued.expiresAt > Date.now() + 29 * 86_400_000);
  const decision = requests[1]!.body;
  assert.deepEqual(decision.decision, { _tag: "pairing-code", access: "full-access", code: "PAIR123" });
  assert.equal(decision.authorization.resource, "http://t3:3773/mcp");
  assert.equal(requests[2]!.body.code, "abc");
  assert.equal(requests[2]!.body.client_id, "client-1");
});

test("a refused sign-in never echoes the response body", async () => {
  const fetcher = (async () => new Response(JSON.stringify({ error: "invalid_grant", access_token: "leak" }), { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(signInWithPairingCode("http://t3", "x", fetcher), (error: Error) => !error.message.includes("leak"));
});

test("the pairing code is read from JSON or plain output", async () => {
  const run = (stdout: string) => (async () => ({ stdout, stderr: "" })) as any;
  assert.equal(await pairingCodeFrom("t3", run('{"id":"1","credential":"ABC"}\n')), "ABC");
  assert.equal(await pairingCodeFrom("t3", run("Token: XYZ\n")), "XYZ");
});

test("the credential signs in once, renews near expiry and after invalidation", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, "state.json"));
  let signIns = 0;
  let expiresIn = 30 * 86_400_000;
  const credential = new T3Credential({
    url: "http://t3", store, renewCommand: "t3 auth pairing create --json",
    pairingCode: async () => "code", signIn: async () => ({ token: `token-${++signIns}`, expiresAt: Date.now() + expiresIn }),
  });
  const [a, b] = await Promise.all([credential.token(), credential.token()]);
  assert.equal(a, "token-1"); assert.equal(b, "token-1");
  assert.equal(await credential.token(), "token-1");
  credential.invalidate();
  assert.equal(await credential.token(), "token-2");
  expiresIn = 4 * 86_400_000;
  credential.invalidate();
  assert.equal(await credential.token(), "token-3");
  assert.equal(await credential.token(), "token-4", "inside the 5-day window it renews again");
  assert.equal(new Store(path.join(root, "state.json")).state.t3?.token, "token-4", "persisted across restarts");
});

test("a fixed token is used as-is", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "t3-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credential = new T3Credential({ url: "http://t3", store: new Store(path.join(root, "s.json")), staticToken: "fixed" });
  assert.equal(await credential.token(), "fixed");
  assert.equal(credential.expiresAt(), undefined);
});
