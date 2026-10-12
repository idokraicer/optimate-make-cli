// Per-organization Make MCP grants in the OS credential store (macOS Keychain, libsecret,
// Windows Credential Manager) via Bun.secrets, under the "make-fixer" service.
// Two entries per organization keep each secret under Windows' ~2.5 KB limit:
//   mcp-grant:org:<id>   long-lived: refresh token + OAuth client credentials (~250 B)
//   mcp-access:org:<id>  short-lived access token cache (~1.6 KB), safe to lose
// A non-secret index file lists which organizations have grants, since Bun.secrets cannot enumerate.

import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SECRET_SERVICE = "make-fixer";
export const GRANT_INDEX_PATH = join(homedir(), ".make-fixer", "mcp-grants.json");

export interface McpGrant {
  organizationId: number;
  organizationName: string | null;
  zone: string | null;
  refreshToken: string;
  refreshTokenExpiresAt: number | null;
  clientId: string;
  clientSecret: string | null;
  grantedAt: number;
}

export interface CachedAccessToken {
  accessToken: string;
  expiresAt: number;
}

export type GrantSummary = Omit<McpGrant, "refreshToken" | "clientId" | "clientSecret">;

export interface SecretsBackend {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

export interface IndexBackend {
  read(): Promise<GrantSummary[]>;
  write(entries: GrantSummary[]): Promise<void>;
}

export class GrantStore {
  constructor(
    private readonly secrets: SecretsBackend = Bun.secrets,
    private readonly index: IndexBackend = fileIndex(GRANT_INDEX_PATH),
  ) {}

  async getGrant(organizationId: number): Promise<McpGrant | null> {
    const raw = await this.secrets.get({ service: SECRET_SERVICE, name: grantName(organizationId) });
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed?.refreshToken === "string" && typeof parsed.clientId === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  async setGrant(grant: McpGrant): Promise<void> {
    await this.secrets.set({
      service: SECRET_SERVICE,
      name: grantName(grant.organizationId),
      value: JSON.stringify(grant),
    });
    const entries = (await this.index.read()).filter((e) => e.organizationId !== grant.organizationId);
    entries.push(summarize(grant));
    entries.sort((a, b) => a.organizationId - b.organizationId);
    await this.index.write(entries);
  }

  async getAccessToken(organizationId: number): Promise<CachedAccessToken | null> {
    const raw = await this.secrets.get({ service: SECRET_SERVICE, name: accessName(organizationId) });
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed?.accessToken === "string" && typeof parsed.expiresAt === "number" ? parsed : null;
    } catch {
      return null;
    }
  }

  async setAccessToken(organizationId: number, token: CachedAccessToken): Promise<void> {
    await this.secrets.set({
      service: SECRET_SERVICE,
      name: accessName(organizationId),
      value: JSON.stringify(token),
    });
  }

  async deleteGrant(organizationId: number): Promise<boolean> {
    const deleted = await this.secrets.delete({ service: SECRET_SERVICE, name: grantName(organizationId) });
    await this.secrets.delete({ service: SECRET_SERVICE, name: accessName(organizationId) });
    const entries = await this.index.read();
    await this.index.write(entries.filter((e) => e.organizationId !== organizationId));
    return deleted;
  }

  async listGrants(): Promise<GrantSummary[]> {
    return await this.index.read();
  }
}

export function grantName(organizationId: number): string {
  return `mcp-grant:org:${organizationId}`;
}

export function accessName(organizationId: number): string {
  return `mcp-access:org:${organizationId}`;
}

function summarize(grant: McpGrant): GrantSummary {
  const { refreshToken: _r, clientId: _c, clientSecret: _s, ...summary } = grant;
  return summary;
}

export function fileIndex(path: string): IndexBackend {
  return {
    async read() {
      const file = Bun.file(path);
      if (!(await file.exists())) return [];
      try {
        const parsed = await file.json();
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
    async write(entries) {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await Bun.write(temp, `${JSON.stringify(entries, null, 2)}\n`);
      await rename(temp, path);
    },
  };
}
