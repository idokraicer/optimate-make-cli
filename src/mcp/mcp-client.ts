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
  readonly code: string = "MCP_TOOL_ERROR";
  constructor(readonly tool: string, message: string) {
    super(`Make MCP tool ${tool} failed: ${message}`);
    this.name = "McpToolError";
  }
}

export class McpRateLimitedError extends McpToolError {
  override readonly code = "MCP_RATE_LIMITED";
  constructor(tool: string, message: string, readonly retryAfterMs: number | null) {
    super(tool, message);
    this.name = "McpRateLimitedError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface McpClientOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  /** Waits between rate-limited attempts; their sum (~60 s) spans Make's per-minute API window. */
  retryDelaysMs?: number[];
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const MAX_RETRY_AFTER_MS = 60_000;

/** Stateless JSON-RPC client for Make's MCP server (streamable HTTP; no session handshake needed). */
export class MakeMcpClient {
  private nextId = 1;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly url: string = MAKE_MCP_URL,
    options: McpClientOptions = {},
  ) {
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /** Calls a tool, retrying with backoff while Make reports rate limiting (organization API limits apply). */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callToolOnce(name, args);
      } catch (error) {
        if (!(error instanceof McpRateLimitedError) || attempt >= this.retryDelaysMs.length) throw error;
        await this.sleep(error.retryAfterMs ?? this.retryDelaysMs[attempt]!);
      }
    }
  }

  private async callToolOnce(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const message = await this.rpc(name, "tools/call", { name, arguments: args });
    if (message.error) {
      const text = String(message.error.message ?? "unknown error");
      throw isRateLimitText(text) ? new McpRateLimitedError(name, text, null) : new McpToolError(name, text);
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
      const text = remarks.join(" ").slice(0, 500) || "the tool reported an error";
      throw isRateLimitText(text) ? new McpRateLimitedError(name, text, null) : new McpToolError(name, text);
    }
    return { data, texts: remarks, isError: false };
  }

  private async rpc(tool: string, method: string, params: Record<string, unknown>): Promise<any> {
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
    if (res.status === 429) {
      throw new McpRateLimitedError(tool, "HTTP 429 Too Many Requests", retryAfterMs(res.headers.get("retry-after")));
    }
    const text = await res.text();
    if (!res.ok) throw new McpToolError(tool, `HTTP ${res.status}`);
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

function isRateLimitText(text: string): boolean {
  return /too many requests|rate[- ]?limit|\b429\b/i.test(text);
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}
