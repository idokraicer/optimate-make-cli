import type { Command } from "commander";
import type { MakeApiClient } from "../make-api/client";
import { exitCodeFor, failureEnvelope, successEnvelope } from "./output";
import { classifyCommandError } from "./examples";

type ConnectionsDependencies = {
  createClient: (baseUrl?: string) => Promise<MakeApiClient>;
  parseMakeUrl: (input: string) => { baseUrl?: string; teamId?: number };
  cliVersion: string;
  writeOutput?: (value: unknown) => void;
};

export function registerConnectionsCommand(
  program: Command,
  dependencies: ConnectionsDependencies,
): void {
  program
    .command("connections")
    .description("List safe, team-scoped connections without authentication data")
    .requiredOption("--from-url <url>", "Make.com URL identifying the target team and zone")
    .action(async (opts) => {
      const emit = dependencies.writeOutput
        ?? ((value: unknown) => console.log(JSON.stringify(value, null, 2)));
      try {
        const parsed = dependencies.parseMakeUrl(opts.fromUrl);
        if (!parsed.baseUrl || !parsed.teamId || parsed.teamId <= 0) {
          throw new Error("--from-url must be a valid team-bearing Make.com URL.");
        }
        const client = await dependencies.createClient(parsed.baseUrl);
        const connections = await client.listConnections(parsed.teamId);
        emit(successEnvelope("connections", {
          teamId: parsed.teamId,
          connections,
        }, {
          cliVersion: dependencies.cliVersion,
          source: "make_api",
          verifiedAt: new Date().toISOString(),
          rateLimit: client.getRateLimitSnapshot(),
        }));
      } catch (error) {
        const classified = classifyCommandError(error, "Connection discovery failed.");
        emit(failureEnvelope("connections", classified));
        process.exitCode = exitCodeFor(classified);
      }
    });
}
