import type { Config } from "./config.js";
import type { LinearApi } from "./linear.js";
import type { Question, Session, Store } from "./state.js";

export interface T3Api { call<T = unknown>(tool: string, args?: Record<string, unknown>): Promise<T> }

export type AgentSessionEvent = {
  type: "AgentSessionEvent"; action: "created" | "prompted" | string; webhookId?: string;
  agentSession: { id: string; issue?: { id: string } | null };
  agentActivity?: { id?: string; signal?: string | null; body?: string; content?: { body?: string } } | null;
  promptContext?: string;
};

type Item = { position: number; itemId: string; runId: string | null; type: string; status: string; title?: string | null; text?: string | null; textTruncated?: boolean; nextTextOffset?: number | null };
type ThreadRead = {
  thread: { status: string; pendingRequestCount?: number; linkedPullRequest?: { url?: string } | null };
  recentRuns: Array<{ runId: string; status: string }>; items: Item[]; hasMore: boolean;
};

const FINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const QUIET = new Set(["user_message", "assistant_message", "reasoning", "checkpoint", "compaction", "user_input_request"]);
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

export function prompt(issue: { identifier: string; title: string; url: string }, context: string | undefined) {
  return `Linear issue ${issue.identifier}: ${issue.title}
${issue.url}

${context ?? ""}

Work on this issue in this repository:
- Make the smallest correct change and follow the repository's conventions.
- Run the relevant tests or checks.
- Commit, push the current branch and open a draft pull request with \`gh pr create --draft\`; mention ${issue.identifier} in its body.
- If a requirement is ambiguous, ask with your question tool instead of guessing.
Finish with a short summary of what changed and the pull request URL.`;
}

/** Tool items carry JSON (`{"toolName": …}`) or a shell transcript; show the name and first line. */
function describe(item: Item): { action: string; parameter: string } {
  const text = item.text ?? "";
  let tool: { toolName?: string; input?: unknown } | undefined;
  try { tool = text.startsWith("{") ? JSON.parse(text) : undefined; } catch { /* plain text */ }
  const parameter = tool ? JSON.stringify(tool.input ?? "").slice(0, 200) : text.split("\n").find(line => line.trim())?.slice(0, 200) ?? "";
  return { action: item.title ?? tool?.toolName ?? item.type.replace(/_/g, " "), parameter };
}

const letter = (i: number) => String.fromCharCode(65 + i);

function questionBody(question: Question) {
  const options = question.options?.map((o, i) => `**${letter(i)}.** ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n");
  return `${question.question}${options ? `\n\n${options}\n\nPick one, or answer in your own words.` : ""}`;
}

/** Maps "B", "2", or an option label to that option; anything else is a free-text answer. */
export function parseAnswer(question: Question, reply: string): string | string[] {
  const options = question.options ?? [];
  const pick = (part: string) => {
    const p = part.trim();
    const byLabel = options.find(o => o.label.toLowerCase() === p.toLowerCase());
    if (byLabel) return byLabel.label;
    const index = /^[A-Za-z]$/.test(p) ? p.toUpperCase().charCodeAt(0) - 65 : /^\d+$/.test(p) ? Number(p) - 1 : -1;
    return options[index]?.label;
  };
  if (question.multiSelect) {
    const picks = reply.split(",").map(pick);
    if (picks.every(Boolean)) return picks as string[];
  }
  return pick(reply) ?? reply.trim();
}

export class Relay {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: {
    config: Config; store: Store; linear: LinearApi; t3: T3Api;
    defaultBranch: (cwd: string) => Promise<string>;
    log?: (message: string) => void;
  }) {}

  /** Webhooks and polls run one at a time, so session state never races. */
  enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch(error => this.deps.log?.(`relay: ${error instanceof Error ? error.stack : error}`));
    return this.queue;
  }

  private get sessions() { return this.deps.store.state.sessions; }

  async handle(event: AgentSessionEvent): Promise<void> {
    const key = `${event.action}:${event.agentSession.id}:${event.agentActivity?.id ?? ""}`;
    if (this.deps.store.state.seen.includes(key)) return;
    this.deps.store.state.seen.push(key);
    this.deps.store.save();
    try {
      const allowed = this.deps.config.allowedUsers;
      if (allowed.length) {
        const actor = await this.deps.linear.actor(event.agentSession.id, event.action === "prompted" ? event.agentActivity?.id : undefined);
        if (!actor || !allowed.includes(actor)) {
          await this.deps.linear.activity(event.agentSession.id, { type: "error", body: "You are not allowed to run this agent." });
          return;
        }
      }
      if (event.action === "created") await this.start(event);
      else if (event.action === "prompted") await this.prompted(event);
    } catch (error) {
      await this.deps.linear.activity(event.agentSession.id, { type: "error", body: `Relay error: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async start(event: AgentSessionEvent) {
    const { linear, t3, config, store } = this.deps;
    const sessionId = event.agentSession.id;
    const issueId = event.agentSession.issue?.id;
    // Linear marks the session unresponsive without an activity within 10 seconds.
    await linear.activity(sessionId, { type: "thought", body: "Starting a T3 Code thread…" });
    if (!issueId) throw new Error("This session has no issue; delegate an issue to the agent.");
    const issue = await linear.issue(issueId);
    const title = config.projects[issue.projectName ?? ""] ?? config.projects["*"];
    if (!title) throw new Error(`No T3 project is mapped to Linear project "${issue.projectName}".`);
    const { projects } = await t3.call<{ projects: Array<{ id: string; title: string; workspaceRoot: string; deletedAt: string | null }> }>("t3_project_list", { limit: 100 });
    const project = projects.find(p => p.title === title && !p.deletedAt);
    if (!project) throw new Error(`T3 project "${title}" not found.`);
    const launched = await t3.call<{ threadId: string; runId: string }>("t3_thread_launch", {
      projectId: project.id, title: `${issue.identifier}: ${issue.title}`, message: prompt(issue, event.promptContext),
      modelSelection: config.model, runtimeMode: "full-access", interactionMode: "default",
      workspaceStrategy: config.workspace === "root" ? { type: "root" }
        : { type: "worktree", baseRef: await this.deps.defaultBranch(project.workspaceRoot), branch: issue.branchName, startFromOrigin: true },
    });
    this.sessions[sessionId] = { linearSessionId: sessionId, issueId, identifier: issue.identifier, t3ThreadId: launched.threadId, cursor: 0, awaitingRunId: launched.runId };
    store.save();
    await linear.activity(sessionId, { type: "action", action: "Started T3 Code thread", parameter: config.workspace === "root" ? project.title : `${project.title} · ${issue.branchName}` });
  }

  private async prompted(event: AgentSessionEvent) {
    const { linear, t3, store } = this.deps;
    const session = this.sessions[event.agentSession.id];
    if (!session?.t3ThreadId) return this.start({ ...event, action: "created" });
    if (event.agentActivity?.signal === "stop") {
      await t3.call("t3_thread_interrupt", { threadId: session.t3ThreadId, clientRequestId: event.agentActivity.id });
      session.stopped = true; delete session.awaitingRunId; delete session.question;
      store.save();
      await linear.activity(session.linearSessionId, { type: "response", body: "Stopped. Send a message to continue." });
      return;
    }
    const reply = (event.agentActivity?.body ?? event.agentActivity?.content?.body ?? "").trim();
    if (!reply) return;
    if (session.question) {
      const pending = session.question;
      const next = pending.questions.find(q => !(q.id in pending.answers))!;
      pending.answers[next.id] = parseAnswer(next, reply);
      const after = pending.questions.find(q => !(q.id in pending.answers));
      if (after) {
        store.save();
        await linear.activity(session.linearSessionId, { type: "elicitation", body: questionBody(after) }, { select: after.options?.map(o => o.label) });
        return;
      }
      await t3.call("t3_pending_request_respond", { threadId: session.t3ThreadId, requestId: pending.requestId, answers: pending.answers });
      delete session.question;
      store.save();
      await linear.activity(session.linearSessionId, { type: "thought", body: "Answer sent; continuing." }, { ephemeral: true });
      return;
    }
    const sent = await t3.call<{ runId?: string }>("t3_thread_send", { threadId: session.t3ThreadId, message: reply, mode: "auto", clientRequestId: event.agentActivity?.id });
    session.stopped = false;
    if (sent.runId) { session.awaitingRunId = sent.runId; delete session.lastReplyItemId; }
    store.save();
    await linear.activity(session.linearSessionId, { type: "thought", body: "Sent to T3 Code." }, { ephemeral: true });
  }

  async poll(): Promise<void> {
    for (const session of Object.values(this.sessions)) {
      if (!session.t3ThreadId || (!session.awaitingRunId && !session.question)) continue;
      try { await this.pollSession(session); }
      catch (error) { this.deps.log?.(`poll ${session.identifier}: ${error instanceof Error ? error.message : error}`); }
    }
  }

  private async pollSession(session: Session) {
    const { t3, linear, store } = this.deps;
    const threadId = session.t3ThreadId!;
    const read = await t3.call<ThreadRead>("t3_thread_read", {
      threadId, view: "activity", limit: 100, maxCharsPerItem: 2000, ...(session.cursor > 0 ? { afterPosition: session.cursor - 1 } : {}),
    });
    for (const item of read.items) {
      if (!FINAL.has(item.status)) break;
      session.cursor = item.position + 1;
      if (item.type === "assistant_message" && item.runId === session.awaitingRunId) session.lastReplyItemId = item.itemId;
      if (QUIET.has(item.type)) continue;
      if (item.type === "error") await linear.activity(session.linearSessionId, { type: "error", body: item.text ?? "T3 Code reported an error." });
      else await linear.activity(session.linearSessionId, { type: "action", ...describe(item) }, { ephemeral: true });
    }
    store.save();

    if (read.thread.pendingRequestCount && !session.question) {
      const { requestIds } = await t3.call<{ requestIds: string[] }>("t3_pending_request_list", { threadId });
      if (requestIds[0]) {
        const request = await t3.call<{ questions: Question[] }>("t3_pending_request_read", { threadId, requestId: requestIds[0] });
        session.question = { requestId: requestIds[0], questions: request.questions, answers: {} };
        store.save();
        const first = request.questions[0]!;
        await linear.activity(session.linearSessionId, { type: "elicitation", body: questionBody(first) }, { select: first.options?.map(o => o.label) });
      }
      return;
    }

    const run = read.recentRuns.find(r => r.runId === session.awaitingRunId);
    if (!run || !FINAL.has(run.status) || read.hasMore || session.question) return;
    delete session.awaitingRunId;
    store.save();
    if (run.status === "failed") {
      await linear.activity(session.linearSessionId, { type: "error", body: "The T3 Code run failed. Send a message to retry." });
      return;
    }
    if (run.status !== "completed") return;
    const summary = session.lastReplyItemId ? await this.fullText(threadId, session.lastReplyItemId) : "";
    const prUrl = read.thread.linkedPullRequest?.url ?? PR_URL.exec(summary)?.[0];
    if (prUrl && prUrl !== session.prUrl) {
      session.prUrl = prUrl;
      store.save();
      await linear.addLinks(session.linearSessionId, [{ label: "Pull request", url: prUrl }]);
      await linear.linkPullRequest(session.issueId, prUrl);
    }
    await linear.activity(session.linearSessionId, { type: "response", body: summary || "Done." });
  }

  private async fullText(threadId: string, itemId: string): Promise<string> {
    let text = "";
    let offset: number | null | undefined = 0;
    while (offset != null) {
      const read: { items: Item[] } = await this.deps.t3.call("t3_thread_read", { threadId, itemId, textOffset: offset, maxCharsPerItem: 20_000 });
      const item = read.items[0];
      text += item?.text ?? "";
      offset = item?.textTruncated ? item.nextTextOffset : null;
    }
    return text;
  }
}
