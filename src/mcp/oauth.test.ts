import { describe, expect, test } from "bun:test";
import { GrantRevokedError, MAKE_MCP_URL, OAuthError, discoverOAuthServer, refreshTokenSet } from "./oauth";

const server = {
  authorizationEndpoint: "https://www.make.test/oauth/v2/authorize",
  tokenEndpoint: "https://www.make.test/oauth/v2/token",
  registrationEndpoint: "https://www.make.test/oauth/v2/register/mcp-openai",
};
const current = { refreshToken: "r1", clientId: "c1", clientSecret: "s1" };

describe("refreshTokenSet", () => {
  test("posts a refresh_token grant for the MCP resource and returns the rotated tokens", async () => {
    let sent: URLSearchParams | null = null;
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      sent = new URLSearchParams(String(init?.body));
      return Response.json({
        access_token: "a2",
        refresh_token: "r2",
        expires_in: 299,
        access_token_expires_at: "2026-10-12T08:33:38.411Z",
        refresh_token_expires_at: "2027-04-11T08:28:38.411Z",
      });
    };
    const tokens = await refreshTokenSet(current, { fetchImpl: fetchImpl as any, server, now: () => 0 });

    expect(Object.fromEntries(sent!)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "r1",
      client_id: "c1",
      client_secret: "s1",
      resource: MAKE_MCP_URL,
    });
    expect(tokens).toEqual({
      accessToken: "a2",
      accessTokenExpiresAt: Date.parse("2026-10-12T08:33:38.411Z"),
      refreshToken: "r2",
      refreshTokenExpiresAt: Date.parse("2027-04-11T08:28:38.411Z"),
      clientId: "c1",
      clientSecret: "s1",
    });
  });

  test("falls back to expires_in and keeps the refresh token when none is returned", async () => {
    const fetchImpl = async () => Response.json({ access_token: "a2", expires_in: 300 });
    const tokens = await refreshTokenSet(current, { fetchImpl: fetchImpl as any, server, now: () => 1000 });
    expect(tokens.accessTokenExpiresAt).toBe(301_000);
    expect(tokens.refreshToken).toBe("r1");
  });

  test("maps a reused/unknown refresh token (Make answers 404) to GrantRevokedError", async () => {
    const fetchImpl = async () => new Response("{}", { status: 404 });
    await expect(refreshTokenSet(current, { fetchImpl: fetchImpl as any, server })).rejects.toBeInstanceOf(GrantRevokedError);
  });

  test("treats server errors as transient, not revoked", async () => {
    const fetchImpl = async () => new Response("{}", { status: 503 });
    const error = await refreshTokenSet(current, { fetchImpl: fetchImpl as any, server }).catch((e) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error).not.toBeInstanceOf(GrantRevokedError);
  });
});

describe("discoverOAuthServer", () => {
  test("follows protected-resource metadata to the RFC 8414 issuer metadata", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      if (url.includes("oauth-protected-resource")) {
        return Response.json({ authorization_servers: ["https://www.make.test/mcp-openai"] });
      }
      return Response.json({
        authorization_endpoint: server.authorizationEndpoint,
        token_endpoint: server.tokenEndpoint,
        registration_endpoint: server.registrationEndpoint,
      });
    };
    expect(await discoverOAuthServer(fetchImpl as any)).toEqual(server);
    expect(urls).toEqual([
      "https://mcp.make.com/.well-known/oauth-protected-resource/claude",
      "https://www.make.test/.well-known/oauth-authorization-server/mcp-openai",
    ]);
  });
});
