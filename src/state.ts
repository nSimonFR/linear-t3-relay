import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Question = { id: string; question: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean };

export type Session = {
  linearSessionId: string; issueId: string; identifier: string;
  t3ThreadId?: string;
  /** First timeline position not yet reported to Linear. */
  cursor: number;
  /** The run whose outcome has not been reported yet. */
  awaitingRunId?: string;
  lastReplyItemId?: string;
  question?: { requestId: string; questions: Question[]; answers: Record<string, string | string[]> };
  prUrl?: string;
  stopped?: boolean;
};

export type Installation = { accessToken: string; refreshToken?: string; expiresAt: number };

export type State = {
  installation?: Installation;
  oauthStates: Record<string, number>;
  sessions: Record<string, Session>;
  /** Webhook deliveries already accepted, so Linear retries are ignored. */
  seen: string[];
};

export class Store {
  state: State;
  constructor(private readonly file: string) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { oauthStates: {}, sessions: {}, seen: [] };
  }
  save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.state.seen = this.state.seen.slice(-1000);
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
