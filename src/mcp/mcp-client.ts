import { MAKE_MCP_URL } from "./oauth";

export interface ToolResult {
  /** structuredContent, or the first JSON text item (object or array) when a tool returns its payload as text. */
  data: unknown;
  /** Human-readable remarks Make returns alongside the data (e.g. cycle caveats, truncation notes). */
  texts: string[];
  isError: boolean;
}

export class McpUnauthorizedError extends Error {
  readonly code = "MCP_UNAUTHORIZED";
  constructor() {
    super("Make MCP rejected the access token.");
    this.name = "McpUnauthorizedError";
  }
}

export class McpToolError extends Error {
  readonly code = "MCP_TOOL_ERROR";
  constructor(readonly tool: string, message: string) {
    super(`Make MCP tool ${tool} failed: ${message}`);
    this.name = "McpToolError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Stateless JSON-RPC client for Make's MCP server (streamable HTTP; no session handshake needed). */
export class MakeMcpClient {
  private nextId = 1;

  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly url: string = MAKE_MCP_URL,
  ) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const message = await this.rpc("tools/call", { name, arguments: args });
    if (message.error) {
      throw new McpToolError(name, String(message.error.message ?? "unknown error"));
    }
    const result = message.result ?? {};
    const content: any[] = Array.isArray(result.content) ? result.content : [];
    const texts = content.filter((c) => c?.type === "text").map((c) => String(c.text ?? ""));
    let data: unknown = result.structuredContent ?? null;
    let payloadIndex = -1;
    // Some tools put the JSON payload in a text item instead of structuredContent.
    texts.forEach((text, index) => {
      if (payloadIndex !== -1 || !looksLikeJson(text)) return;
      try {
        const parsed = JSON.parse(text);
        payloadIndex = index;
        if (data === null) data = parsed;
      } catch {
        // Truncated payloads ("…[truncated]") are not JSON; they stay as remarks.
      }
    });
    const remarks = texts.filter((_, index) => index !== payloadIndex);
    if (result.isError) {
      throw new McpToolError(name, remarks.join(" ").slice(0, 500) || "the tool reported an error");
    }
    return { data, texts: remarks, isError: false };
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<any> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    if (res.status === 401) throw new McpUnauthorizedError();
    const text = await res.text();
    if (!res.ok) throw new McpToolError(String(params.name ?? method), `HTTP ${res.status}`);
    return parseRpcBody(text);
  }
}

/** Accepts either a plain JSON-RPC body or a server-sent-events stream carrying one. */
export function parseRpcBody(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (const chunk of data.reverse()) {
    try {
      const parsed = JSON.parse(chunk);
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
    } catch {
      // Keep looking for the JSON-RPC response event.
    }
  }
  throw new Error("Make MCP returned no JSON-RPC response.");
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}
