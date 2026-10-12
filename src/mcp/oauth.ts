// OAuth for Make's official MCP server (https://mcp.make.com), which exposes per-module
// execution data that the public REST API does not. Standard MCP authorization:
// discovery → dynamic client registration → authorization code + PKCE (S256) on a loopback
// redirect → rotating refresh tokens. A grant covers exactly one organization, chosen by the
// person on Make's consent page.

export const MAKE_MCP_URL = "https://mcp.make.com/claude";

export interface OAuthServerMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

export interface TokenSet {
  accessToken: string;
  /** Epoch ms. */
  accessTokenExpiresAt: number;
  refreshToken: string;
  /** Epoch ms, or null when Make does not say. */
  refreshTokenExpiresAt: number | null;
  clientId: string;
  clientSecret: string | null;
}

export class OAuthError extends Error {
  readonly code = "MCP_OAUTH_FAILED";
  constructor(message: string, readonly httpStatus: number | null = null) {
    super(message);
    this.name = "OAuthError";
  }
}

/** The refresh token was rejected (used, revoked, or expired); only a new consent recovers. */
export class GrantRevokedError extends OAuthError {
  constructor(message = "The Make MCP grant is no longer valid; consent is required again.") {
    super(message, 400);
    this.name = "GrantRevokedError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function discoverOAuthServer(fetchImpl: FetchLike = fetch): Promise<OAuthServerMetadata> {
  const resourceUrl = new URL(MAKE_MCP_URL);
  const resource = await getJson(
    fetchImpl,
    `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname}`,
  );
  const issuer = Array.isArray(resource?.authorization_servers) ? String(resource.authorization_servers[0]) : "";
  if (!issuer) throw new OAuthError("Make MCP did not advertise an authorization server.");
  const issuerUrl = new URL(issuer);
  // RFC 8414: the well-known segment goes between the host and the issuer path.
  const metadata = await getJson(
    fetchImpl,
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/+$/, "")}`,
  );
  const result = {
    authorizationEndpoint: String(metadata?.authorization_endpoint ?? ""),
    tokenEndpoint: String(metadata?.token_endpoint ?? ""),
    registrationEndpoint: String(metadata?.registration_endpoint ?? ""),
  };
  if (!result.authorizationEndpoint || !result.tokenEndpoint || !result.registrationEndpoint) {
    throw new OAuthError("Make's OAuth metadata is missing an endpoint.");
  }
  return result;
}

export interface ConsentOptions {
  /** Opens the consent URL for the person; the URL is also passed to `log`. */
  openUrl: (url: string) => void;
  log: (message: string) => void;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** Runs one interactive consent. The person picks the organization on Make's page. */
export async function runConsent(options: ConsentOptions): Promise<TokenSet> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const server = await discoverOAuthServer(fetchImpl);
  const state = randomUrlSafe(16);
  const verifier = randomUrlSafe(32);
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

  let settle!: (result: { code: string } | { error: string }) => void;
  const callback = new Promise<{ code: string } | { error: string }>((resolve) => (settle = resolve));
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      if (url.searchParams.get("state") !== state) return new Response("State mismatch", { status: 400 });
      const code = url.searchParams.get("code");
      settle(code ? { code } : { error: url.searchParams.get("error") ?? "unknown_error" });
      return new Response(
        code
          ? "make-fixer is now authorized for this organization. You can close this tab."
          : "Authorization was not granted. You can close this tab.",
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    },
  });

  try {
    const redirectUri = `http://127.0.0.1:${listener.port}/callback`;
    // A fresh client per consent: the loopback port changes, and the redirect URI is part of the registration.
    const registration = await postJson(fetchImpl, server.registrationEndpoint, {
      client_name: "make-fixer CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
    const clientId = typeof registration?.client_id === "string" ? registration.client_id : "";
    if (!clientId) throw new OAuthError("Make did not register the make-fixer OAuth client.");
    const clientSecret = typeof registration.client_secret === "string" ? registration.client_secret : null;

    const authorizeUrl = new URL(server.authorizationEndpoint);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: MAKE_MCP_URL,
    }).toString();
    options.log(`Open this URL if the browser does not open by itself:\n  ${authorizeUrl}`);
    options.openUrl(authorizeUrl.toString());

    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      callback,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OAuthError("Timed out waiting for the Make consent page.")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if ("error" in outcome) throw new OAuthError(`Make consent was not granted (${outcome.error}).`);

    const tokens = await postForm(fetchImpl, server.tokenEndpoint, {
      grant_type: "authorization_code",
      code: outcome.code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      resource: MAKE_MCP_URL,
    });
    return toTokenSet(tokens, clientId, clientSecret, now());
  } finally {
    listener.stop(true);
  }
}

/** Exchanges a refresh token. Make rotates refresh tokens: the old one stops working immediately. */
export async function refreshTokenSet(
  current: Pick<TokenSet, "refreshToken" | "clientId" | "clientSecret">,
  options: { fetchImpl?: FetchLike; now?: () => number; server?: OAuthServerMetadata } = {},
): Promise<TokenSet> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const server = options.server ?? await discoverOAuthServer(fetchImpl);
  let tokens: any;
  try {
    tokens = await postForm(fetchImpl, server.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: current.clientId,
      ...(current.clientSecret ? { client_secret: current.clientSecret } : {}),
      resource: MAKE_MCP_URL,
    });
  } catch (error) {
    // Make answers 404 for a used/unknown refresh token, and 400/401 for invalid_grant or a revoked client.
    if (error instanceof OAuthError && [400, 401, 404].includes(error.httpStatus ?? 0)) {
      throw new GrantRevokedError();
    }
    throw error;
  }
  return toTokenSet(tokens, current.clientId, current.clientSecret, (options.now ?? Date.now)(), current.refreshToken);
}

function toTokenSet(
  body: any,
  clientId: string,
  clientSecret: string | null,
  now: number,
  previousRefreshToken?: string,
): TokenSet {
  if (typeof body?.access_token !== "string" || body.access_token.length === 0) {
    throw new OAuthError("Make's token response did not include an access token.");
  }
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : previousRefreshToken;
  if (!refreshToken) throw new OAuthError("Make's token response did not include a refresh token.");
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: epochMs(body.access_token_expires_at)
      ?? now + (Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 5 * 60_000),
    refreshToken,
    refreshTokenExpiresAt: epochMs(body.refresh_token_expires_at),
    clientId,
    clientSecret,
  };
}

function epochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<any> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new OAuthError(`Make OAuth discovery failed (${res.status}) at ${url}.`, res.status);
  return await res.json();
}

async function postJson(fetchImpl: FetchLike, url: string, body: unknown): Promise<any> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return await readOAuthResponse(res, url);
}

async function postForm(fetchImpl: FetchLike, url: string, fields: Record<string, string>): Promise<any> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields),
  });
  return await readOAuthResponse(res, url);
}

async function readOAuthResponse(res: Response, url: string): Promise<any> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Reported below without echoing the body, which may contain token material.
  }
  if (!res.ok) {
    const reason = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
    throw new OAuthError(
      `Make OAuth request failed (${res.status})${reason ? `: ${reason.slice(0, 120)}` : ""} at ${new URL(url).pathname}.`,
      res.status,
    );
  }
  return body;
}

function randomUrlSafe(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
