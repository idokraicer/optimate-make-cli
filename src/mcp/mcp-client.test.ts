import { describe, expect, test } from "bun:test";
import { MakeMcpClient, McpToolError, McpUnauthorizedError, parseRpcBody } from "./mcp-client";

function sse(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

function client(respond: (body: any, headers: Headers) => Response) {
  const requests: Array<{ body: any; headers: Headers }> = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    requests.push({ body, headers });
    return respond(body, headers);
  };
  return { mcp: new MakeMcpClient(async () => "tok", fetchImpl as any, "https://mcp.test/claude"), requests };
}

describe("MakeMcpClient.callTool", () => {
  test("sends a bearer JSON-RPC tools/call and returns structuredContent plus remarks", async () => {
    const { mcp, requests } = client((body) =>
      new Response(sse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: { records: [] },
          content: [
            { type: "text", text: '{"records":[]}' },
            { type: "text", text: "Cycle numbers could not be determined." },
          ],
        },
      }))
    );
    const result = await mcp.callTool("scenario_execution_module_get", { moduleId: 2 });
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer tok");
    expect(requests[0]!.body).toMatchObject({
      method: "tools/call",
      params: { name: "scenario_execution_module_get", arguments: { moduleId: 2 } },
    });
    expect(result).toEqual({ data: { records: [] }, texts: ["Cycle numbers could not be determined."], isError: false });
  });

  test("parses a JSON array payload returned as text", async () => {
    const { mcp } = client((body) =>
      Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: '[{"id":491016}]' }] } })
    );
    expect((await mcp.callTool("organization_list", {})).data).toEqual([{ id: 491016 }]);
  });

  test("keeps a truncated, unparseable payload as a remark", async () => {
    const { mcp } = client((body) =>
      Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: '{"a":"…[truncated]' }] } })
    );
    const result = await mcp.callTool("x", {});
    expect(result.data).toBeNull();
    expect(result.texts).toEqual(['{"a":"…[truncated]']);
  });

  test("raises McpUnauthorizedError on 401 and McpToolError on tool errors", async () => {
    const unauthorized = client(() => new Response("{}", { status: 401 }));
    await expect(unauthorized.mcp.callTool("x", {})).rejects.toBeInstanceOf(McpUnauthorizedError);

    const failing = client((body) =>
      Response.json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "Scenario not found." }] } })
    );
    await expect(failing.mcp.callTool("x", {})).rejects.toThrow(McpToolError);
  });
});

describe("parseRpcBody", () => {
  test("picks the JSON-RPC response from an event stream", () => {
    const text = `event: ping\ndata: {"note":1}\n\n${sse({ jsonrpc: "2.0", id: 1, result: { ok: true } })}`;
    expect(parseRpcBody(text)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });
});
