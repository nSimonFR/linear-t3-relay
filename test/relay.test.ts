import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Config } from "../src/config.js";
import type { Activity, LinearApi } from "../src/linear.js";
import { parseAnswer, Relay, type AgentSessionEvent } from "../src/relay.js";
import { Store } from "../src/state.js";

const config: Config = {
  baseUrl: "https://relay.example", host: "127.0.0.1", port: 0, installSecret: "s",
  linearClientId: "c", linearClientSecret: "cs", linearWebhookSecret: "ws",
  t3Url: "http://t3", t3Token: "t", projects: { "*": "sandbox" }, model: { instanceId: "claudeAgent", model: "claude-sonnet-5" },
  statePath: "", pollMs: 0,
};

const RUN1 = "run:1";
const item = (position: number, fields: Record<string, unknown>) => ({ position, itemId: `i${position}`, runId: RUN1, status: "completed", title: null, text: "", ...fields });

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "relay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const activities: Array<{ content: Activity; options?: { ephemeral?: boolean; select?: string[] } }> = [];
  const links: Array<{ label: string; url: string }> = [];
  const calls: Array<{ tool: string; args: any }> = [];
  const thread = { status: "running", pendingRequestCount: 0, linkedPullRequest: null as null | { url: string } };
  const t3state = { runs: [{ runId: RUN1, status: "running" }], items: [] as any[], pending: [] as string[] };
  const linear: LinearApi = {
    async activity(_session, content, options) { activities.push({ content, options }); },
    async addLinks(_session, added) { links.push(...added); },
    async issue() { return { identifier: "NSI-7", title: "Greet loudly", url: "https://linear.app/x/NSI-7", branchName: "feature/nsi-7-greet-loudly", projectName: "T3 bridge sandbox" }; },
  };
  const t3 = { async call(tool: string, args: any = {}): Promise<any> {
    calls.push({ tool, args });
    switch (tool) {
      case "t3_project_list": return { projects: [{ id: "p1", title: "sandbox", workspaceRoot: "/repo", deletedAt: null }] };
      case "t3_thread_launch": return { threadId: "t3-thread", runId: RUN1 };
      case "t3_thread_send": return { runId: "run:2" };
      case "t3_thread_read":
        if (args.itemId) return { items: [{ ...t3state.items.find(i => i.itemId === args.itemId), textTruncated: false }] };
        return { thread: { ...thread, pendingRequestCount: t3state.pending.length }, recentRuns: t3state.runs,
          items: t3state.items.filter(i => args.afterPosition === undefined || i.position > args.afterPosition), hasMore: false };
      case "t3_pending_request_list": return { requestIds: t3state.pending };
      case "t3_pending_request_read": return { questions: [{ id: "q1", question: "Which greeting?", options: [{ label: "Hello" }, { label: "Hi" }] }, { id: "q2", question: "Exclamation?" }] };
      default: return {};
    }
  } };
  const store = new Store(path.join(root, "state.json"));
  const relay = new Relay({ config, store, linear, t3, defaultBranch: async () => "main" });
  const event = (action: string, activity?: AgentSessionEvent["agentActivity"]): AgentSessionEvent =>
    ({ type: "AgentSessionEvent", action, agentSession: { id: "ls1", issue: { id: "issue-1" } }, agentActivity: activity, promptContext: "<issue>Greet loudly</issue>" });
  return { relay, store, activities, links, calls, thread, t3state, event, root };
}

test("delegation launches a worktree thread on the issue branch, once", async t => {
  const f = await fixture(t);
  await f.relay.handle(f.event("created"));
  await f.relay.handle(f.event("created"));
  const launches = f.calls.filter(c => c.tool === "t3_thread_launch");
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0]!.args.workspaceStrategy, { type: "worktree", baseRef: "main", branch: "feature/nsi-7-greet-loudly", startFromOrigin: true });
  assert.match(launches[0]!.args.message, /NSI-7[\s\S]*<issue>Greet loudly<\/issue>[\s\S]*gh pr create --draft/);
  assert.equal(f.activities[0]!.content.type, "thought");
  assert.equal(f.store.state.sessions.ls1!.t3ThreadId, "t3-thread");
});

test("an unmapped project reports an error in Linear", async t => {
  const f = await fixture(t);
  f.calls.length = 0;
  (f.relay as any).deps.config = { ...config, projects: { Other: "x" } };
  await f.relay.handle(f.event("created"));
  assert.equal(f.activities.at(-1)!.content.type, "error");
  assert.match((f.activities.at(-1)!.content as { body: string }).body, /No T3 project is mapped/);
});

test("progress, then the final reply and the PR link", async t => {
  const f = await fixture(t);
  await f.relay.handle(f.event("created"));
  f.t3state.items = [item(0, { type: "user_message" }), item(1, { type: "command_execution", title: "Ran tests", text: "$ pytest\n2 passed" }), item(2, { type: "file_change", status: "running" })];
  await f.relay.poll();
  assert.deepEqual(f.activities.at(-1), { content: { type: "action", action: "Ran tests", parameter: "$ pytest" }, options: { ephemeral: true } });
  assert.equal(f.store.state.sessions.ls1!.cursor, 2);

  f.t3state.items[2]!.status = "completed";
  f.t3state.items.push(item(3, { type: "assistant_message", text: "Done. https://github.com/o/r/pull/4" }));
  f.t3state.runs = [{ runId: RUN1, status: "completed" }];
  await f.relay.poll();
  assert.deepEqual(f.links, [{ label: "Pull request", url: "https://github.com/o/r/pull/4" }]);
  assert.deepEqual(f.activities.at(-1)!.content, { type: "response", body: "Done. https://github.com/o/r/pull/4" });
  const reported = f.activities.length;
  await f.relay.poll();
  assert.equal(f.activities.length, reported, "a finished run is reported once");
});

test("questions are asked one at a time in Linear and answered together", async t => {
  const f = await fixture(t);
  await f.relay.handle(f.event("created"));
  f.t3state.pending = ["req-1"];
  await f.relay.poll();
  assert.deepEqual(f.activities.at(-1)!.options, { select: ["Hello", "Hi"] });
  assert.match((f.activities.at(-1)!.content as { body: string }).body, /Which greeting\?[\s\S]*\*\*B\.\*\* Hi/);
  await f.relay.handle(f.event("prompted", { id: "a1", body: "B" }));
  assert.match((f.activities.at(-1)!.content as { body: string }).body, /Exclamation\?/);
  await f.relay.handle(f.event("prompted", { id: "a2", body: "yes, two of them" }));
  assert.deepEqual(f.calls.at(-1), { tool: "t3_pending_request_respond", args: { threadId: "t3-thread", requestId: "req-1", answers: { q1: "Hi", q2: "yes, two of them" } } });
});

test("follow-ups go to the same thread; stop interrupts it", async t => {
  const f = await fixture(t);
  await f.relay.handle(f.event("created"));
  await f.relay.handle(f.event("prompted", { id: "a1", body: "Also update the README" }));
  assert.deepEqual(f.calls.at(-1), { tool: "t3_thread_send", args: { threadId: "t3-thread", message: "Also update the README", mode: "auto", clientRequestId: "a1" } });
  assert.equal(f.store.state.sessions.ls1!.awaitingRunId, "run:2");
  await f.relay.handle(f.event("prompted", { id: "a2", signal: "stop" }));
  assert.equal(f.calls.at(-1)!.tool, "t3_thread_interrupt");
  assert.equal(f.store.state.sessions.ls1!.awaitingRunId, undefined);
  assert.equal(f.activities.at(-1)!.content.type, "response");
});

test("a failed run is reported as an error", async t => {
  const f = await fixture(t);
  await f.relay.handle(f.event("created"));
  f.t3state.runs = [{ runId: RUN1, status: "failed" }];
  await f.relay.poll();
  assert.equal(f.activities.at(-1)!.content.type, "error");
});

test("answers map letters, numbers and labels to options", () => {
  const q = { id: "q", question: "?", options: [{ label: "Red" }, { label: "Blue" }] };
  assert.equal(parseAnswer(q, "b"), "Blue");
  assert.equal(parseAnswer(q, "1"), "Red");
  assert.equal(parseAnswer(q, "blue"), "Blue");
  assert.equal(parseAnswer(q, "purple please"), "purple please");
  assert.deepEqual(parseAnswer({ ...q, multiSelect: true }, "A, B"), ["Red", "Blue"]);
});
