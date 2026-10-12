import type { Command } from "commander";
import type { GrantStore } from "../mcp/grant-store";
import type { McpAuth } from "../mcp/mcp-auth";
import { successEnvelope } from "./output";

type McpCommandDependencies = {
  /** Resolves an organization from --org or any Make URL (team URLs are looked up). */
  resolveOrganization: (options: { org?: string; fromUrl?: string }) => Promise<number | null>;
  createAuth: (options: { allowConsent: boolean }) => Pick<McpAuth, "connect">;
  store: Pick<GrantStore, "listGrants" | "deleteGrant">;
  cliVersion: string;
  writeOutput?: (value: unknown) => void;
  now?: () => number;
};

export function registerMcpCommand(program: Command, dependencies: McpCommandDependencies): void {
  const emit = dependencies.writeOutput ?? ((value: unknown) =>
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2)));
  const meta = () => ({
    cliVersion: dependencies.cliVersion,
    source: "make-mcp-oauth",
    verifiedAt: new Date().toISOString(),
  });
  const now = dependencies.now ?? Date.now;

  const mcp = program
    .command("mcp")
    .description("Manage per-organization consent for Make's MCP server (full execution data)")
    .addHelpText(
      "after",
      `
Make's public API does not return module input/output bundles; its official MCP server does.
Access is granted per organization on Make's consent page (OAuth). make-fixer stores each grant
in the OS credential store (macOS Keychain / libsecret / Windows Credential Manager) under the
"make-fixer" service, and refreshes it silently — a grant lasts about 6 months between uses.
Commands that need an organization without a grant open the consent page automatically
(pass --no-consent to fail instead).

Examples:
  make-fixer mcp login --org <ORG_ID>
  make-fixer mcp login --from-url "https://eu1.make.com/<TEAM_ID>/scenarios/<SCENARIO_ID>/edit"
  make-fixer mcp status
  make-fixer mcp logout --org <ORG_ID>
`,
    );

  mcp
    .command("login")
    .description("Open Make's consent page and store the organization's grant")
    .option("--org <organizationId>", "Organization to authorize (choose it on the consent page)")
    .option("--from-url <url>", "Any Make.com URL; its organization (or team's organization) is used")
    .action(async (opts) => {
      const organizationId = await dependencies.resolveOrganization(opts);
      const granted = await dependencies.createAuth({ allowConsent: true }).connect(organizationId);
      emit(successEnvelope("mcp.login", { organizationId: granted.id, name: granted.name, zone: granted.zone }, meta()));
    });

  mcp
    .command("status")
    .description("List organizations with a stored grant")
    .action(async () => {
      const grants = await dependencies.store.listGrants();
      emit(successEnvelope("mcp.status", {
        grants: grants.map((grant) => ({
          organizationId: grant.organizationId,
          name: grant.organizationName,
          zone: grant.zone,
          grantedAt: new Date(grant.grantedAt).toISOString(),
          expiresAt: grant.refreshTokenExpiresAt ? new Date(grant.refreshTokenExpiresAt).toISOString() : null,
          expired: grant.refreshTokenExpiresAt !== null && grant.refreshTokenExpiresAt <= now(),
        })),
      }, meta()));
    });

  mcp
    .command("logout")
    .description("Delete an organization's stored grant")
    .requiredOption("--org <organizationId>", "Organization whose grant to delete")
    .action(async (opts) => {
      const organizationId = Number(opts.org);
      if (!Number.isInteger(organizationId) || organizationId <= 0) {
        throw new Error("--org must be a positive organization ID.");
      }
      const deleted = await dependencies.store.deleteGrant(organizationId);
      emit(successEnvelope("mcp.logout", { organizationId, deleted }, meta()));
    });
}
