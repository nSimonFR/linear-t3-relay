import type { Config } from "./config.js";
import type { LinearApi } from "./linear.js";
import type { Question, Session, Store } from "./state.js";

export interface T3Api { call<T = unknown>(tool: string, args?: Record<string, unknown>): Promise<T> }

export type AgentSessionEvent = {
  type: "AgentSessionEvent"; action: "created" | "prompted" | string; webhookId?: string; organizationId?: string;
  agentSession: { id: string; issue?: { id: string } | null };
  agentActivity?: { id?: string; signal?: string | null; body?: string; content?: { body?: string } } | null;
  promptContext?: string;
};

type Item = { position: number; itemId: string; runId: string | null; type: string; status: string; title?: string | null; text?: string | null; textTruncated?: boolean; nextTextOffset?: number | null };
type ThreadRead = {
  thread: { status: string; pendingRequestCount?: number; linkedPullRequest?: { url?: string } | null };
  recentRuns: Array<{ runId: string; status: string }>; items: Item[]; hasMore: boolean;
};

/** An error whose message is safe to show in Linear; anything else stays in the log. */
export class UserError extends Error {}

const FINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const QUIET = new Set(["user_message", "assistant_message", "reasoning", "checkpoint", "compaction", "user_input_request"]);
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
/** Activities posted per poll, so a long backlog cannot hold the queue (and new delegations) for minutes. */
const MAX_POSTS_PER_POLL = 15;
/** About 30 minutes of failed polls at the default interval: long enough to outlast T3 being closed for a while. */
const MAX_POLL_FAILURES = 600;
const LAUNCH_ADOPT_WINDOW_MS = 10 * 60_000;

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

/** The PR a `gh pr create` printed; other commands mention PRs they did not open. */
export function createdPullRequest(item: Item): string | undefined {
  const text = item.text ?? "";
  if (item.type !== "command_execution" || !/\bgh\s+pr\s+create\b/.test(text.split("\n").find(line => line.trim()) ?? "")) return undefined;
  return PR_URL.exec(text)?.[0];
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

  /**
   * Outside the queue: Linear marks a session unresponsive without an activity within
   * 10 seconds, and the queue may be busy polling.
   */
  async acknowledge(event: AgentSessionEvent): Promise<void> {
    if (event.action !== "created" || this.deps.store.state.seen.includes(this.key(event))) return;
    if (!await this.fromOurWorkspace(event)) return;
    await this.deps.linear.activity(event.agentSession.id, { type: "thought", body: "Starting a T3 Code thread…" })
      .catch(error => this.deps.log?.(`acknowledge: ${error instanceof Error ? error.message : error}`));
  }

  private get sessions() { return this.deps.store.state.sessions; }
  private key(event: AgentSessionEvent) { return `${event.action}:${event.agentSession.id}:${event.agentActivity?.id ?? ""}`; }

  private async fromOurWorkspace(event: AgentSessionEvent): Promise<boolean> {
    if (!event.organizationId) return true;
    return event.organizationId === await this.deps.linear.organizationId();
  }

  async handle(event: AgentSessionEvent): Promise<void> {
    const { store, linear, config, log } = this.deps;
    const key = this.key(event);
    if (store.state.seen.includes(key)) return;
    store.state.seen.push(key);
    store.save();
    try {
      if (!await this.fromOurWorkspace(event)) {
        log?.(`ignored a webhook from another workspace (${event.organizationId})`);
        return;
      }
      if (config.allowedUsers.length) {
        const actor = await linear.actor(event.agentSession.id, event.action === "prompted" ? event.agentActivity?.id : undefined);
        if (!actor || !config.allowedUsers.includes(actor)) {
          await linear.activity(event.agentSession.id, { type: "error", body: "You are not allowed to run this agent." });
          return;
        }
      }
      if (event.action === "created") await this.start(event);
      else if (event.action === "prompted") await this.prompted(event);
    } catch (error) {
      log?.(`${event.action} ${event.agentSession.id}: ${error instanceof Error ? error.stack : error}`);
      const body = error instanceof UserError ? error.message : "The relay hit an error; details are in its log.";
      await linear.activity(event.agentSession.id, { type: "error", body });
    }
  }

  private async start(event: AgentSessionEvent) {
    const { linear, t3, config, store } = this.deps;
    const sessionId = event.agentSession.id;
    const issueId = event.agentSession.issue?.id;
    if (!issueId) throw new UserError("This session has no issue; delegate an issue to the agent.");
    const issue = await linear.issue(issueId);
    const title = config.projects[issue.projectName ?? ""] ?? config.projects["*"];
    if (!title) throw new UserError(`No T3 project is mapped to Linear project "${issue.projectName}".`);
    const { projects } = await t3.call<{ projects: Array<{ id: string; title: string; workspaceRoot: string; deletedAt: string | null }> }>("t3_project_list", { limit: 100 });
    const project = projects.find(p => p.title === title && !p.deletedAt);
    if (!project) throw new UserError(`T3 project "${title}" not found.`);
    const threadTitle = `${issue.identifier}: ${issue.title}`;

    const previous = this.sessions[sessionId];
    if (previous?.launchingSince) {
      const adopted = await this.findLaunched(project.id, threadTitle, previous.launchingSince);
      if (adopted) return this.adopt(previous, adopted, `${project.title} (recovered)`);
    }
    const session: Session = { linearSessionId: sessionId, issueId, identifier: issue.identifier, cursor: 0, launchingSince: new Date().toISOString() };
    this.sessions[sessionId] = session;
    store.save();
    const workspaceStrategy = config.workspace === "root" ? { type: "root" }
      : { type: "worktree", baseRef: config.baseRef ?? await this.deps.defaultBranch(project.workspaceRoot), branch: issue.branchName, startFromOrigin: true };
    let launched: { threadId: string; runId?: string };
    try {
      launched = await t3.call("t3_thread_launch", {
        projectId: project.id, title: threadTitle, message: prompt(issue, event.promptContext),
        modelSelection: config.model, runtimeMode: "full-access", interactionMode: "default", workspaceStrategy,
      });
    } catch (error) {
      // T3 may have accepted the launch before the reply was lost: adopt it rather than run a second agent.
      const found = await this.findLaunched(project.id, threadTitle, session.launchingSince!).catch(() => undefined);
      if (!found) throw error;
      launched = found;
    }
    await this.adopt(session, launched, config.workspace === "root" ? project.title : `${project.title} · ${issue.branchName}`);
  }

  private async adopt(session: Session, launched: { threadId: string; runId?: string }, where: string) {
    session.t3ThreadId = launched.threadId;
    session.awaitingRunId = launched.runId ?? `pending:${launched.threadId}`;
    delete session.launchingSince;
    this.deps.store.save();
    await this.deps.linear.activity(session.linearSessionId, { type: "action", action: "Started T3 Code thread", parameter: where });
  }

  private async findLaunched(projectId: string, title: string, since: string): Promise<{ threadId: string; runId?: string } | undefined> {
    if (Date.now() - Date.parse(since) > LAUNCH_ADOPT_WINDOW_MS) return undefined;
    const { threads } = await this.deps.t3.call<{ threads: Array<{ threadId: string; title: string; createdAt: string; latestRunId?: string | null }> }>(
      "t3_thread_list", { projectId, titleContains: title, limit: 20 });
    const thread = threads.find(t => t.title === title && t.createdAt >= since);
    return thread && { threadId: thread.threadId, runId: thread.latestRunId ?? undefined };
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
    if (session.question && await this.answer(session, reply)) return;
    const sent = await t3.call<{ runId?: string }>("t3_thread_send", { threadId: session.t3ThreadId, message: reply, mode: "auto", clientRequestId: event.agentActivity?.id });
    session.stopped = false;
    session.awaitingRunId = sent.runId ?? session.awaitingRunId ?? `pending:${session.t3ThreadId}`;
    delete session.lastReplyItemId;
    store.save();
    await linear.activity(session.linearSessionId, { type: "thought", body: "Sent to T3 Code." }, { ephemeral: true });
  }

  /** Feeds a reply to the pending question. False when the question is gone: the reply is then a message. */
  private async answer(session: Session, reply: string): Promise<boolean> {
    const { linear, t3, store } = this.deps;
    const pending = session.question!;
    const next = pending.questions.find(q => !(q.id in pending.answers))!;
    pending.answers[next.id] = parseAnswer(next, reply);
    const after = pending.questions.find(q => !(q.id in pending.answers));
    if (after) {
      store.save();
      await linear.activity(session.linearSessionId, { type: "elicitation", body: questionBody(after) }, { select: after.options?.map(o => o.label) });
      return true;
    }
    delete session.question;
    session.answeredRequests = [...(session.answeredRequests ?? []), pending.requestId].slice(-20);
    store.save();
    try {
      await t3.call("t3_pending_request_respond", { threadId: session.t3ThreadId, requestId: pending.requestId, answers: pending.answers });
    } catch (error) {
      // Answered in T3 already, expired, or its run ended.
      this.deps.log?.(`answer ${session.identifier}: ${error instanceof Error ? error.message : error}`);
      return false;
    }
    await linear.activity(session.linearSessionId, { type: "thought", body: "Answer sent; continuing." }, { ephemeral: true });
    return true;
  }

  async poll(): Promise<void> {
    for (const session of Object.values(this.sessions)) {
      if (!session.t3ThreadId || (!session.awaitingRunId && !session.question)) continue;
      try {
        await this.pollSession(session);
        if (session.pollFailures) { delete session.pollFailures; this.deps.store.save(); }
      } catch (error) {
        this.deps.log?.(`poll ${session.identifier}: ${error instanceof Error ? error.message : error}`);
        session.pollFailures = (session.pollFailures ?? 0) + 1;
        this.deps.store.save();
        if (session.pollFailures >= MAX_POLL_FAILURES) await this.giveUp(session);
      }
    }
  }

  private async giveUp(session: Session) {
    delete session.awaitingRunId; delete session.question; delete session.pollFailures;
    this.deps.store.save();
    await this.deps.linear.activity(session.linearSessionId, { type: "error", body: "Lost track of the T3 Code thread; send a message to try again." }).catch(() => {});
  }

  private async pollSession(session: Session) {
    const { t3, linear, store } = this.deps;
    const threadId = session.t3ThreadId!;
    const read = await t3.call<ThreadRead>("t3_thread_read", {
      threadId, view: "activity", limit: 100, runLimit: 50, maxCharsPerItem: 2000, ...(session.cursor > 0 ? { afterPosition: session.cursor - 1 } : {}),
    });
    const runStatus = new Map(read.recentRuns.map(r => [r.runId, r.status]));
    if (session.awaitingRunId?.startsWith("pending:") && read.recentRuns[0]) session.awaitingRunId = read.recentRuns[0].runId;

    let posts = 0;
    for (const item of read.items) {
      // An item that never settles (a request, a tool cut off by an interrupt) must not block the rest once its run ended.
      const settled = FINAL.has(item.status) || item.type === "user_input_request" || FINAL.has(runStatus.get(item.runId ?? "") ?? "");
      if (!settled || posts >= MAX_POSTS_PER_POLL) break;
      if (item.type === "assistant_message" && item.runId === session.awaitingRunId) session.lastReplyItemId = item.itemId;
      await this.attachPullRequest(session, createdPullRequest(item));
      if (!QUIET.has(item.type)) {
        if (item.type === "error") await linear.activity(session.linearSessionId, { type: "error", body: item.text ?? "T3 Code reported an error." });
        else await linear.activity(session.linearSessionId, { type: "action", ...describe(item) }, { ephemeral: true });
        posts++;
      }
      session.cursor = item.position + 1;
      store.save();
    }
    await this.attachPullRequest(session, read.thread.linkedPullRequest?.url);

    const pending = read.thread.pendingRequestCount
      ? (await t3.call<{ requestIds: string[] }>("t3_pending_request_list", { threadId })).requestIds.filter(id => !session.answeredRequests?.includes(id))
      : [];
    if (session.question && !pending.includes(session.question.requestId)) {
      // Answered in T3 or expired: replies go to the thread again.
      delete session.question;
      store.save();
    }
    if (!session.question && pending[0]) {
      const request = await t3.call<{ questions: Question[] }>("t3_pending_request_read", { threadId, requestId: pending[0] });
      const first = request.questions[0]!;
      await linear.activity(session.linearSessionId, { type: "elicitation", body: questionBody(first) }, { select: first.options?.map(o => o.label) });
      session.question = { requestId: pending[0], questions: request.questions, answers: {} };
      store.save();
      return;
    }
    if (session.question) return;

    const run = read.recentRuns.find(r => r.runId === session.awaitingRunId);
    if (!run || !FINAL.has(run.status) || read.hasMore || posts >= MAX_POSTS_PER_POLL) return;
    // Post first, then mark done: a failed post is retried on the next poll.
    if (run.status === "completed") {
      const summary = session.lastReplyItemId ? await this.fullText(threadId, session.lastReplyItemId) : "";
      if (!session.prUrl) await this.attachPullRequest(session, PR_URL.exec(summary)?.[0]);
      await linear.activity(session.linearSessionId, { type: "response", body: summary || "Done." });
    } else if (run.status === "failed") {
      await linear.activity(session.linearSessionId, { type: "error", body: "The T3 Code run failed. Send a message to retry." });
    } else if (!session.stopped) {
      await linear.activity(session.linearSessionId, { type: "response", body: "Stopped in T3 Code. Send a message to continue." });
    }
    delete session.awaitingRunId;
    store.save();
  }

  private async attachPullRequest(session: Session, url: string | undefined) {
    if (!url || url === session.prUrl) return;
    await this.deps.linear.addLinks(session.linearSessionId, [{ label: "Pull request", url }]);
    await this.deps.linear.linkPullRequest(session.issueId, url);
    session.prUrl = url;
    this.deps.store.save();
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
