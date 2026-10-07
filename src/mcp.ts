/** A T3Code tool call that returned a structured failure (`failureMode: "return"`). */
export class McpToolError extends Error {
  constructor(readonly tool: string, readonly code: string | undefined, message: string) { super(message); }
}
export class McpTransportError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

type JsonRpcResponse = { id?: number | string; result?: unknown; error?: { code: number; message: string } };

/** Minimal MCP client for T3Code's public `/mcp` endpoint (streamable HTTP, protocol 2025-06-18). */
export class T3CodeMcp {
  private session: string | undefined;
  private nextId = 1;
  private readonly endpoint: URL;

  constructor(url: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    this.endpoint = new URL("/mcp", url);
  }

  private async post(body: Record<string, unknown>): Promise<JsonRpcResponse | undefined> {
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST", redirect: "error",
        headers: {
          authorization: `Bearer ${this.token}`, "content-type": "application/json",
          accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18",
          ...(this.session ? { "mcp-session-id": this.session } : {}),
        },
        body: JSON.stringify(body),
        // Bounds one request; long work is observed by polling, never awaited here.
        signal: AbortSignal.timeout(60_000),
      });
    } catch { throw new McpTransportError("T3Code MCP connection failed. Check T3CODE_URL and that T3Code is running."); }
    const session = response.headers.get("mcp-session-id");
    if (session) this.session = session;
    if (response.status === 404 && this.session) { this.session = undefined; throw new McpTransportError("T3Code MCP session expired.", 404); }
    if (!response.ok && response.status !== 202) throw new McpTransportError(`T3Code MCP HTTP ${response.status}.`, response.status);
    if (!("id" in body)) return undefined;
    const text = await response.text();
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const message = JSON.parse(line.slice(5)) as JsonRpcResponse;
        if (message.id === body.id) return message;
      }
      throw new McpTransportError("T3Code MCP stream ended without a response.");
    }
    return JSON.parse(text) as JsonRpcResponse;
  }

  private async initialize() {
    const response = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "linear-t3-relay", version: "0.1.0" },
    } });
    if (response?.error) throw new McpTransportError(`T3Code MCP initialize failed: ${response.error.message}`);
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}, retried = false): Promise<T> {
    if (!this.session) await this.initialize();
    let response: JsonRpcResponse | undefined;
    try {
      response = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name: tool, arguments: args } });
    } catch (error) {
      if (!retried && error instanceof McpTransportError && error.status === 404) return this.call(tool, args, true);
      throw error;
    }
    if (!response) throw new McpTransportError(`T3Code ${tool} returned no response.`);
    if (response.error) throw new McpToolError(tool, String(response.error.code), response.error.message);
    const result = response.result as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
    const text = result.content?.find(part => part.type === "text")?.text;
    let payload: unknown = result.structuredContent;
    if (payload === undefined && text !== undefined) { try { payload = JSON.parse(text); } catch { payload = text; } }
    if (result.isError) {
      const failure = payload as { code?: string; message?: string; error?: { code?: string; message?: string } } | string | undefined;
      const detail = typeof failure === "string" ? { message: failure } : failure?.error ?? failure;
      throw new McpToolError(tool, detail?.code, detail?.message ?? `T3Code ${tool} failed.`);
    }
    return payload as T;
  }
}
