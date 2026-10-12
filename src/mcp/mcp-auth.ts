import { homedir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./file-lock";
import type { GrantStore, McpGrant } from "./grant-store";
import { MakeMcpClient, McpUnauthorizedError, type ToolResult } from "./mcp-client";
import { GrantRevokedError, type TokenSet } from "./oauth";

/** Raised when a command needs an organization's consent but may not open a browser. */
export class ConsentRequiredError extends Error {
  readonly code = "MCP_CONSENT_REQUIRED";
  constructor(readonly organizationId: number) {
    super(
      `make-fixer has no Make MCP consent for organization ${organizationId}. `
        + `Run: make-fixer mcp login --org ${organizationId}`,
    );
    this.name = "ConsentRequiredError";
  }
}

/** The person approved a different organization on the consent page than the one needed. */
export class OrganizationMismatchError extends Error {
  readonly code = "MCP_ORGANIZATION_MISMATCH";
  constructor(readonly expected: number, readonly granted: { id: number; name: string | null }) {
    super(
      `Consent was granted for organization ${granted.id}${granted.name ? ` (${granted.name})` : ""}, `
        + `but organization ${expected} is needed. That grant was saved; run again and choose organization ${expected} on the consent page.`,
    );
    this.name = "OrganizationMismatchError";
  }
}

export interface GrantedOrganization {
  id: number;
  name: string | null;
  zone: string | null;
}

export interface McpAuthDependencies {
  store: Pick<GrantStore, "getGrant" | "setGrant" | "getAccessToken" | "setAccessToken" | "deleteGrant">;
  /** Interactive consent; the person picks the organization on Make's page. */
  consent: () => Promise<TokenSet>;
  refresh: (grant: McpGrant) => Promise<TokenSet>;
  /** Which organization(s) an access token is granted for (Make's `organization_list` tool). */
  identify: (accessToken: string) => Promise<GrantedOrganization[]>;
  /** False for non-interactive callers: throw ConsentRequiredError instead of opening a browser. */
  allowConsent: boolean;
  lockPath?: (organizationId: number) => string;
  log?: (message: string) => void;
  now?: () => number;
}

const EXPIRY_MARGIN_MS = 30_000;

export class McpAuth {
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: McpAuthDependencies) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((message) => console.error(message));
  }

  /** Runs consent for an organization and stores the grant. Verifies which organization was approved. */
  async connect(organizationId: number | null): Promise<GrantedOrganization> {
    if (!this.deps.allowConsent) {
      if (organizationId === null) throw new Error("An organization is required for non-interactive consent.");
      throw new ConsentRequiredError(organizationId);
    }
    this.log(
      organizationId === null
        ? "Opening Make's consent page. Choose the organization to authorize."
        : `Make consent is needed for organization ${organizationId}. Opening the consent page — choose organization ${organizationId} there.`,
    );
    const tokens = await this.deps.consent();
    const granted = (await this.deps.identify(tokens.accessToken))[0];
    if (!granted) throw new Error("Make did not report which organization was authorized.");

    await this.deps.store.setGrant({
      organizationId: granted.id,
      organizationName: granted.name,
      zone: granted.zone,
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      clientId: tokens.clientId,
      clientSecret: tokens.clientSecret,
      grantedAt: this.now(),
    });
    await this.deps.store.setAccessToken(granted.id, {
      accessToken: tokens.accessToken,
      expiresAt: tokens.accessTokenExpiresAt,
    });
    if (organizationId !== null && granted.id !== organizationId) {
      throw new OrganizationMismatchError(organizationId, granted);
    }
    return granted;
  }

  /** A valid access token for the organization, refreshing (or asking for consent) as needed. */
  async accessToken(organizationId: number, rejected?: string): Promise<string> {
    const cached = await this.deps.store.getAccessToken(organizationId);
    if (this.usable(cached, rejected)) return cached!.accessToken;

    const lockPath = (this.deps.lockPath ?? defaultLockPath)(organizationId);
    const outcome = await withFileLock(lockPath, async (): Promise<string | "consent"> => {
      // Another process may have refreshed while this one waited for the lock.
      const current = await this.deps.store.getAccessToken(organizationId);
      if (this.usable(current, rejected)) return current!.accessToken;

      const grant = await this.deps.store.getGrant(organizationId);
      if (!grant) return "consent";
      let tokens: TokenSet;
      try {
        tokens = await this.deps.refresh(grant);
      } catch (error) {
        if (!(error instanceof GrantRevokedError)) throw error;
        await this.deps.store.deleteGrant(organizationId);
        return "consent";
      }
      // Persist the rotated refresh token before anything else: the previous one is already dead.
      await this.deps.store.setGrant({
        ...grant,
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? grant.refreshTokenExpiresAt,
      });
      await this.deps.store.setAccessToken(organizationId, {
        accessToken: tokens.accessToken,
        expiresAt: tokens.accessTokenExpiresAt,
      });
      return tokens.accessToken;
    });
    if (outcome !== "consent") return outcome;

    // Consent can take minutes, so it runs outside the lock.
    await this.connect(organizationId);
    const fresh = await this.deps.store.getAccessToken(organizationId);
    if (!fresh) throw new Error("Consent finished but no access token was stored.");
    return fresh.accessToken;
  }

  /** Calls a Make MCP tool as the organization's grant, retrying once if the token is rejected. */
  async callTool(organizationId: number, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    let rejected: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(organizationId, rejected);
      try {
        return await new MakeMcpClient(async () => token).callTool(name, args);
      } catch (error) {
        if (!(error instanceof McpUnauthorizedError) || attempt > 0) throw error;
        rejected = token;
      }
    }
  }

  private usable(token: { accessToken: string; expiresAt: number } | null, rejected?: string): boolean {
    return Boolean(token)
      && token!.accessToken !== rejected
      && token!.expiresAt - EXPIRY_MARGIN_MS > this.now();
  }
}

function defaultLockPath(organizationId: number): string {
  return join(homedir(), ".make-fixer", "locks", `mcp-org-${organizationId}.lock`);
}

/** Reads the organization(s) an access token covers via Make's `organization_list` tool. */
export async function identifyGrantedOrganizations(accessToken: string): Promise<GrantedOrganization[]> {
  const result = await new MakeMcpClient(async () => accessToken).callTool("organization_list", {});
  const list = Array.isArray(result.data)
    ? result.data
    : Array.isArray((result.data as any)?.organizations) ? (result.data as any).organizations : [];
  return list.flatMap((org: any) =>
    Number.isInteger(org?.id)
      ? [{
          id: org.id,
          name: typeof org.name === "string" ? org.name : null,
          zone: typeof org.zone === "string" ? org.zone : null,
        }]
      : []
  );
}
