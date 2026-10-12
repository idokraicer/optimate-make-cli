import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrantStore, type GrantSummary, type SecretsBackend } from "./grant-store";
import {
  ConsentRequiredError,
  McpAuth,
  OrganizationMismatchError,
  type McpAuthDependencies,
} from "./mcp-auth";
import { GrantRevokedError, type TokenSet } from "./oauth";

const NOW = 1_800_000_000_000;

function memorySecrets(): SecretsBackend & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async ({ name }) => values.get(name) ?? null,
    set: async ({ name, value }) => void values.set(name, value),
    delete: async ({ name }) => values.delete(name),
  };
}

function memoryStore() {
  const secrets = memorySecrets();
  let index: GrantSummary[] = [];
  const store = new GrantStore(secrets, {
    read: async () => index,
    write: async (entries) => void (index = entries),
  });
  return { store, secrets, index: () => index };
}

function tokens(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-new",
    accessTokenExpiresAt: NOW + 300_000,
    refreshToken: "refresh-new",
    refreshTokenExpiresAt: NOW + 180 * 86_400_000,
    clientId: "client",
    clientSecret: "secret",
    ...overrides,
  };
}

function harness(overrides: Partial<McpAuthDependencies> = {}) {
  const { store, secrets, index } = memoryStore();
  const calls: string[] = [];
  const lockDir = mkdtempSync(join(tmpdir(), "mcp-auth-test-"));
  const deps: McpAuthDependencies = {
    store,
    allowConsent: true,
    consent: async () => {
      calls.push("consent");
      return tokens({ accessToken: "access-consent", refreshToken: "refresh-consent" });
    },
    refresh: async (grant) => {
      calls.push(`refresh ${grant.refreshToken}`);
      return tokens();
    },
    identify: async () => [{ id: 491016, name: "Optimate Automations", zone: "eu1.make.com" }],
    lockPath: (org) => join(lockDir, `${org}.lock`),
    log: () => {},
    now: () => NOW,
    ...overrides,
  };
  return { auth: new McpAuth(deps), store, secrets, calls, index };
}

async function seedGrant(store: GrantStore, organizationId = 491016) {
  await store.setGrant({
    organizationId,
    organizationName: "Optimate Automations",
    zone: "eu1.make.com",
    refreshToken: "refresh-old",
    refreshTokenExpiresAt: NOW + 86_400_000,
    clientId: "client",
    clientSecret: "secret",
    grantedAt: NOW - 1000,
  });
}

describe("McpAuth.accessToken", () => {
  test("returns a cached access token that is not about to expire", async () => {
    const h = harness();
    await seedGrant(h.store);
    await h.store.setAccessToken(491016, { accessToken: "cached", expiresAt: NOW + 120_000 });
    expect(await h.auth.accessToken(491016)).toBe("cached");
    expect(h.calls).toEqual([]);
  });

  test("refreshes a near-expiry token and persists the rotated refresh token", async () => {
    const h = harness();
    await seedGrant(h.store);
    await h.store.setAccessToken(491016, { accessToken: "stale", expiresAt: NOW + 10_000 });

    expect(await h.auth.accessToken(491016)).toBe("access-new");
    expect(h.calls).toEqual(["refresh refresh-old"]);
    expect((await h.store.getGrant(491016))?.refreshToken).toBe("refresh-new");
    expect(await h.store.getAccessToken(491016)).toEqual({ accessToken: "access-new", expiresAt: NOW + 300_000 });
  });

  test("refreshes when the cached token was rejected by the server", async () => {
    const h = harness();
    await seedGrant(h.store);
    await h.store.setAccessToken(491016, { accessToken: "revoked", expiresAt: NOW + 120_000 });
    expect(await h.auth.accessToken(491016, "revoked")).toBe("access-new");
  });

  test("opens consent when the organization has no grant", async () => {
    const h = harness();
    expect(await h.auth.accessToken(491016)).toBe("access-consent");
    expect(h.calls).toEqual(["consent"]);
    expect((await h.store.getGrant(491016))?.refreshToken).toBe("refresh-consent");
    expect(h.index().map((e) => e.organizationId)).toEqual([491016]);
  });

  test("deletes a revoked grant and asks for consent again", async () => {
    const h = harness({
      refresh: async () => {
        throw new GrantRevokedError();
      },
    });
    await seedGrant(h.store);
    expect(await h.auth.accessToken(491016)).toBe("access-consent");
    expect(h.calls).toEqual(["consent"]);
  });

  test("never opens a browser when consent is not allowed", async () => {
    const h = harness({ allowConsent: false });
    await expect(h.auth.accessToken(491016)).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(h.calls).toEqual([]);
  });

  test("stores a grant for the organization actually approved, then reports the mismatch", async () => {
    const h = harness({ identify: async () => [{ id: 777, name: "Other", zone: "eu2.make.com" }] });
    const error = await h.auth.accessToken(491016).catch((e) => e);
    expect(error).toBeInstanceOf(OrganizationMismatchError);
    expect(error.message).toContain("choose organization 491016");
    expect(await h.store.getGrant(777)).not.toBeNull();
    expect(await h.store.getGrant(491016)).toBeNull();
  });

  test("a second process waiting on the lock reuses the token the first one refreshed", async () => {
    let refreshes = 0;
    const h = harness({
      refresh: async () => {
        refreshes++;
        await Bun.sleep(50);
        return tokens();
      },
    });
    await seedGrant(h.store);
    const [a, b] = await Promise.all([h.auth.accessToken(491016), h.auth.accessToken(491016)]);
    expect([a, b]).toEqual(["access-new", "access-new"]);
    expect(refreshes).toBe(1);
  });
});

describe("GrantStore", () => {
  test("keeps each keychain secret under the Windows Credential Manager limit", async () => {
    const { store, secrets } = memoryStore();
    await seedGrant(store);
    await store.setAccessToken(491016, { accessToken: "x".repeat(1500), expiresAt: NOW });
    for (const value of secrets.values.values()) expect(value.length).toBeLessThan(2500);
  });

  test("never writes token material to the index file", async () => {
    const { store, index } = memoryStore();
    await seedGrant(store);
    expect(JSON.stringify(index())).not.toContain("refresh-old");
    expect(JSON.stringify(index())).not.toContain("secret");
  });

  test("logout removes both secrets and the index entry", async () => {
    const { store, secrets, index } = memoryStore();
    await seedGrant(store);
    await store.setAccessToken(491016, { accessToken: "a", expiresAt: NOW });
    expect(await store.deleteGrant(491016)).toBe(true);
    expect(secrets.values.size).toBe(0);
    expect(index()).toEqual([]);
  });
});
