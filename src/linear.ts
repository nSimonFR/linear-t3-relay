import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { Store } from "./state.js";

const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";

export type Activity =
  | { type: "thought" | "elicitation" | "response" | "error"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

export type Issue = { identifier: string; title: string; url: string; branchName: string; projectName: string | null };

/** What the relay needs from Linear; the seam the tests replace. */
export interface LinearApi {
  activity(sessionId: string, content: Activity, options?: { ephemeral?: boolean; select?: string[] }): Promise<void>;
  addLinks(sessionId: string, links: Array<{ label: string; url: string }>): Promise<void>;
  issue(issueId: string): Promise<Issue>;
  /** Attaches the PR to the issue itself, as Linear's GitHub integration would. */
  linkPullRequest(issueId: string, url: string): Promise<void>;
  /** Who started the session, or who wrote the activity when one is given. */
  actor(sessionId: string, activityId?: string): Promise<string | null>;
}

export function verifySignature(secret: string, signature: string | undefined, body: Buffer): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

export class Linear implements LinearApi {
  constructor(private readonly config: Config, private readonly store: Store, private readonly fetcher: typeof fetch = fetch) {}

  installUrl(): string {
    const state = randomBytes(24).toString("base64url");
    this.store.state.oauthStates[state] = Date.now() + 10 * 60_000;
    this.store.save();
    const url = new URL("https://linear.app/oauth/authorize");
    for (const [key, value] of Object.entries({
      client_id: this.config.linearClientId, redirect_uri: `${this.config.baseUrl}/linear/oauth/callback`, response_type: "code",
      scope: "read,write,app:assignable,app:mentionable", state, actor: "app",
    })) url.searchParams.set(key, value);
    return url.href;
  }

  async completeInstall(code: string, state: string): Promise<void> {
    const expires = this.store.state.oauthStates[state];
    delete this.store.state.oauthStates[state];
    if (!expires || expires < Date.now()) throw new Error("Invalid or expired OAuth state.");
    await this.token({ grant_type: "authorization_code", code, redirect_uri: `${this.config.baseUrl}/linear/oauth/callback` });
  }

  private async token(grant: Record<string, string>) {
    const response = await this.fetcher(TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...grant, client_id: this.config.linearClientId, client_secret: this.config.linearClientSecret }),
    });
    const json = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
    if (!response.ok || !json.access_token) throw new Error(`Linear token request failed: ${json.error_description ?? response.status}`);
    this.store.state.installation = {
      accessToken: json.access_token, refreshToken: json.refresh_token ?? this.store.state.installation?.refreshToken,
      expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000,
    };
    this.store.save();
  }

  private async accessToken(): Promise<string> {
    const installation = this.store.state.installation;
    if (!installation) throw new Error("The Linear app is not installed; open /linear/install.");
    if (installation.expiresAt - 5 * 60_000 > Date.now()) return installation.accessToken;
    if (!installation.refreshToken) throw new Error("Linear token expired and cannot be refreshed; reinstall the app.");
    await this.token({ grant_type: "refresh_token", refresh_token: installation.refreshToken });
    return this.store.state.installation!.accessToken;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(GRAPHQL_URL, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await this.accessToken()}` },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000),
    });
    const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };
    if (!response.ok || json.errors?.length) throw new Error(`Linear GraphQL failed: ${json.errors?.[0]?.message ?? response.status}`);
    return json.data!;
  }

  async activity(sessionId: string, content: Activity, options: { ephemeral?: boolean; select?: string[] } = {}) {
    await this.graphql(`mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`, { input: {
      agentSessionId: sessionId, content, ...(options.ephemeral ? { ephemeral: true } : {}),
      ...(options.select?.length ? { signal: "select", signalMetadata: { options: options.select.map(value => ({ label: value, value })) } } : {}),
    } });
  }

  async addLinks(sessionId: string, links: Array<{ label: string; url: string }>) {
    await this.graphql(`mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }`,
      { id: sessionId, input: { addedExternalUrls: links } });
  }

  async issue(issueId: string): Promise<Issue> {
    const data = await this.graphql<{ issue: { identifier: string; title: string; url: string; branchName: string; project: { name: string } | null } }>(
      `query($id: String!) { issue(id: $id) { identifier title url branchName project { name } } }`, { id: issueId });
    return { ...data.issue, projectName: data.issue.project?.name ?? null };
  }

  async actor(sessionId: string, activityId?: string): Promise<string | null> {
    if (activityId) {
      const data = await this.graphql<{ agentActivity: { user: { id: string } | null } }>(`query($id: String!) { agentActivity(id: $id) { user { id } } }`, { id: activityId });
      return data.agentActivity.user?.id ?? null;
    }
    const data = await this.graphql<{ agentSession: { creator: { id: string } | null } }>(`query($id: String!) { agentSession(id: $id) { creator { id } } }`, { id: sessionId });
    return data.agentSession.creator?.id ?? null;
  }

  async linkPullRequest(issueId: string, url: string) {
    try {
      await this.graphql(`mutation($issueId: String!, $url: String!) { attachmentLinkGitHubPR(issueId: $issueId, url: $url) { success } }`, { issueId, url });
    } catch {
      // Without the GitHub integration Linear refuses a PR link; a plain link still shows on the issue.
      await this.graphql(`mutation($issueId: String!, $url: String!) { attachmentLinkURL(issueId: $issueId, url: $url, title: "Pull request") { success } }`, { issueId, url });
    }
  }
}
