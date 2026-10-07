export type Config = {
  baseUrl: string; host: string; port: number; installSecret: string;
  linearClientId: string; linearClientSecret: string; linearWebhookSecret: string;
  t3Url: string; t3Token: string;
  /** Linear project name → T3 project title; "*" is the fallback. */
  projects: Record<string, string>;
  model: { instanceId: string; model: string; options?: Record<string, string | boolean> };
  /** "worktree": one per issue, on its Linear branch. "root": the project's own checkout. */
  workspace: "worktree" | "root";
  /** Linear user ids allowed to delegate or prompt; empty allows everyone. */
  allowedUsers: string[];
  statePath: string; pollMs: number;
};

export function configFromEnv(env: NodeJS.ProcessEnv): Config {
  const need = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}; see .env.example.`);
    return value;
  };
  const [instanceId, ...model] = need("T3CODE_MODEL").split("/");
  if (!instanceId || !model.length) throw new Error("T3CODE_MODEL must be <provider-instance>/<model>, e.g. claudeAgent/claude-sonnet-5.");
  const projects = env.T3CODE_PROJECTS ? JSON.parse(env.T3CODE_PROJECTS) as Record<string, string> : { "*": need("T3CODE_PROJECT") };
  return {
    baseUrl: need("BASE_URL").replace(/\/$/, ""), host: env.HOST || "127.0.0.1", port: Number(env.PORT || 8787),
    installSecret: need("INSTALL_SECRET"),
    linearClientId: need("LINEAR_CLIENT_ID"), linearClientSecret: need("LINEAR_CLIENT_SECRET"), linearWebhookSecret: need("LINEAR_WEBHOOK_SECRET"),
    t3Url: need("T3CODE_URL"), t3Token: need("T3CODE_TOKEN"),
    projects, model: { instanceId, model: model.join("/"), ...(env.T3CODE_MODEL_OPTIONS ? { options: JSON.parse(env.T3CODE_MODEL_OPTIONS) } : {}) },
    workspace: env.T3CODE_WORKSPACE === "root" ? "root" : "worktree",
    allowedUsers: (env.ALLOWED_USER_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean),
    statePath: env.STATE_PATH || "./data/state.json", pollMs: Number(env.POLL_MS || 3000),
  };
}
