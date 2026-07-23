import type { Command } from "commander";
import type { ClassifiedApiError } from "../make-api/api-error";
import { classifyApiResponse } from "../make-api/api-error";
import type { MakeApiClient } from "../make-api/client";
import type { RateLimitSnapshot } from "../make-api/rate-limiter";
import { failureEnvelope, successEnvelope } from "./output";

export interface CapabilityProbe {
  name: string;
  probed: boolean;
  supported: boolean;
  evidence: {
    method: "GET";
    path: string;
    httpStatus: number | null;
    providerCode: string | null;
  };
  limitation?: ClassifiedApiError;
}

export interface DoctorData {
  platform: string;
  configuredZone: string;
  resolvedZone: string;
  authenticatedZones: string[];
  authentication: {
    valid: boolean;
  };
  organizationId: number | null;
  scenarioId: number | null;
  capabilities: CapabilityProbe[];
  rateLimit: RateLimitSnapshot;
}

type ParsedMakeUrl = {
  baseUrl?: string;
  teamId?: number;
  organizationId?: number;
  scenarioId?: number;
};

type ScenarioInput = {
  scenarioId: number;
  teamId?: number;
  baseUrl?: string;
};

type DoctorClient = Pick<
  MakeApiClient,
  | "getScenarioUrl"
  | "listOrganizations"
  | "fetchTeam"
  | "fetchOrganization"
  | "fetchScenario"
  | "fetchBlueprint"
  | "fetchScenarioInterface"
  | "getRateLimitSnapshot"
>;

type DoctorDependencies = {
  createClient: (baseUrl?: string) => Promise<DoctorClient>;
  resolveScenarioClient: (
    scenarioId: number,
    baseUrlOverride?: string,
    teamId?: number,
  ) => Promise<DoctorClient>;
  parseMakeUrl: (input: string) => ParsedMakeUrl;
  parseScenarioInput: (input: string) => ScenarioInput;
  configuredBaseUrl: () => Promise<string>;
  cliVersion: string;
  platform?: string;
  writeOutput?: (value: unknown) => void;
};

type DoctorOptions = {
  fromUrl?: string;
  scenario?: string;
  json?: boolean;
  human?: boolean;
};

const UNPROBED: ClassifiedApiError = {
  code: "INVALID_DATA",
  message: "Not probed because the required context was not supplied.",
  httpStatus: null,
  providerCode: null,
  retryable: false,
};

export function registerDoctorCommand(
  program: Command,
  dependencies: DoctorDependencies,
): void {
  program
    .command("doctor")
    .description("Diagnose Make API access using safe, read-only capability probes")
    .option("--from-url <url>", "Resolve organization, scenario, and zone context from any Make.com URL")
    .option("-s, --scenario <id>", "Make.com scenario ID or URL")
    .option("--json", "Output the default JSON envelope explicitly")
    .option("--human", "Render readable diagnostics instead of the default JSON")
    .action(async (opts: DoctorOptions) => {
      const emit = dependencies.writeOutput ?? ((value: unknown) => console.log(
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
      ));
      try {
        const data = await diagnose(opts, dependencies);
        if (opts.human) {
          emit(renderHumanDoctor(data));
          return;
        }
        emit(successEnvelope("doctor", data, {
          cliVersion: dependencies.cliVersion,
          source: "safe_get_probes",
          verifiedAt: new Date().toISOString(),
          evidenceMethod: "GET",
        }));
      } catch (error) {
        const classified = inputFailure(error);
        emit(failureEnvelope("doctor", classified));
        process.exitCode = 1;
      }
    });
}

async function diagnose(
  opts: DoctorOptions,
  dependencies: DoctorDependencies,
): Promise<DoctorData> {
  if (opts.fromUrl && opts.scenario) {
    throw new Error("Choose either --from-url or --scenario, not both.");
  }

  const configuredBaseUrl = await dependencies.configuredBaseUrl();
  let parsed: ParsedMakeUrl = {};
  let scenario: ScenarioInput | undefined;

  if (opts.scenario) {
    scenario = dependencies.parseScenarioInput(opts.scenario);
    parsed = {
      baseUrl: scenario.baseUrl,
      teamId: scenario.teamId,
      scenarioId: scenario.scenarioId,
    };
  } else if (opts.fromUrl) {
    parsed = dependencies.parseMakeUrl(opts.fromUrl);
    if (!parsed.baseUrl) throw new Error("--from-url must be a valid Make.com URL.");
    if (parsed.scenarioId) {
      scenario = {
        scenarioId: parsed.scenarioId,
        teamId: parsed.teamId,
        baseUrl: parsed.baseUrl,
      };
    }
  }

  const client = scenario && !scenario.baseUrl
    ? await dependencies.resolveScenarioClient(
      scenario.scenarioId,
      undefined,
      scenario.teamId,
    )
    : await dependencies.createClient(parsed.baseUrl);
  const resolvedBaseUrl = new URL(client.getScenarioUrl(scenario?.scenarioId ?? 1)).origin;
  const resolvedZone = zoneName(resolvedBaseUrl);
  const capabilities: CapabilityProbe[] = [];

  const authentication = await probe(
    "organizations.list",
    "/api/v2/organizations",
    () => client.listOrganizations(),
  );
  capabilities.push(authentication);

  if (!authentication.supported) {
    appendContextProbes(capabilities, parsed, scenario, null);
    return buildDoctorData(
      dependencies,
      configuredBaseUrl,
      resolvedZone,
      parsed.organizationId ?? null,
      scenario?.scenarioId ?? null,
      capabilities,
      client.getRateLimitSnapshot(),
      false,
    );
  }

  let organizationId = parsed.organizationId ?? null;
  if (parsed.teamId) {
    let teamResult: unknown;
    const teamProbe = await probe(
      "teams.read",
      `/api/v2/teams/${parsed.teamId}`,
      async () => {
        teamResult = await client.fetchTeam(parsed.teamId!);
        return teamResult;
      },
    );
    capabilities.push(teamProbe);
    if (teamProbe.supported) {
      organizationId = organizationIdFrom(teamResult) ?? organizationId;
    }
  }

  let scenarioProbe: CapabilityProbe | undefined;
  if (scenario && !organizationId) {
    let scenarioResult: unknown;
    scenarioProbe = await probe(
      "scenarios.read",
      `/api/v2/scenarios/${scenario.scenarioId}`,
      async () => {
        scenarioResult = await client.fetchScenario(scenario!.scenarioId);
        return scenarioResult;
      },
    );
    organizationId = organizationIdFrom(scenarioResult);
  }

  if (organizationId) {
    capabilities.push(await probe(
      "organizations.read",
      `/api/v2/organizations/${organizationId}`,
      () => client.fetchOrganization(organizationId!),
    ));
  } else {
    capabilities.push(unprobed(
      "organizations.read",
      "/api/v2/organizations/{organizationId}",
      "Not probed because no organization ID could be resolved.",
    ));
  }

  if (scenario) {
    capabilities.push(scenarioProbe ?? await probe(
      "scenarios.read",
      `/api/v2/scenarios/${scenario.scenarioId}`,
      () => client.fetchScenario(scenario!.scenarioId),
    ));
    capabilities.push(await probe(
      "blueprints.read",
      `/api/v2/scenarios/${scenario.scenarioId}/blueprint`,
      () => client.fetchBlueprint(scenario!.scenarioId),
    ));
    capabilities.push(await probe(
      "scenario_interface.read",
      `/api/v2/scenarios/${scenario.scenarioId}/interface`,
      () => client.fetchScenarioInterface(scenario!.scenarioId),
    ));
  } else {
    appendUnprobedScenarioCapabilities(capabilities);
  }

  return buildDoctorData(
    dependencies,
    configuredBaseUrl,
    resolvedZone,
    organizationId,
    scenario?.scenarioId ?? null,
    capabilities,
    client.getRateLimitSnapshot(),
    true,
  );
}

async function probe(
  name: string,
  path: string,
  action: () => Promise<unknown>,
): Promise<CapabilityProbe> {
  try {
    await action();
    return {
      name,
      probed: true,
      supported: true,
      evidence: {
        method: "GET",
        path,
        httpStatus: 200,
        providerCode: null,
      },
    };
  } catch (error) {
    const limitation = await classifyClientError(error);
    return {
      name,
      probed: true,
      supported: false,
      evidence: {
        method: "GET",
        path,
        httpStatus: limitation.httpStatus,
        providerCode: limitation.providerCode,
      },
      limitation,
    };
  }
}

async function classifyClientError(error: unknown): Promise<ClassifiedApiError> {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\b(\d{3}):\s*([\s\S]*)$/);
  if (match) {
    return classifyApiResponse(new Response(match[2], {
      status: Number(match[1]),
      headers: { "content-type": "application/json" },
    }));
  }
  return {
    code: "TRANSIENT",
    message: "The Make API probe failed before receiving an HTTP response.",
    httpStatus: null,
    providerCode: null,
    retryable: true,
  };
}

function appendContextProbes(
  capabilities: CapabilityProbe[],
  parsed: ParsedMakeUrl,
  scenario: ScenarioInput | undefined,
  organizationId: number | null,
): void {
  if (parsed.teamId) {
    capabilities.push(unprobed(
      "teams.read",
      `/api/v2/teams/${parsed.teamId}`,
      "Not probed because authentication was not established.",
    ));
  }
  capabilities.push(unprobed(
    "organizations.read",
    organizationId || parsed.organizationId
      ? `/api/v2/organizations/${organizationId ?? parsed.organizationId}`
      : "/api/v2/organizations/{organizationId}",
    "Not probed because authentication was not established.",
  ));
  if (scenario) appendUnprobedScenarioCapabilities(capabilities, scenario.scenarioId);
  else appendUnprobedScenarioCapabilities(capabilities);
}

function appendUnprobedScenarioCapabilities(
  capabilities: CapabilityProbe[],
  scenarioId?: number,
): void {
  const id = scenarioId ?? "{scenarioId}";
  const message = scenarioId
    ? "Not probed because authentication was not established."
    : "Not probed because no scenario ID was supplied.";
  capabilities.push(
    unprobed("scenarios.read", `/api/v2/scenarios/${id}`, message),
    unprobed("blueprints.read", `/api/v2/scenarios/${id}/blueprint`, message),
    unprobed("scenario_interface.read", `/api/v2/scenarios/${id}/interface`, message),
  );
}

function unprobed(name: string, path: string, message: string): CapabilityProbe {
  return {
    name,
    probed: false,
    supported: false,
    evidence: {
      method: "GET",
      path,
      httpStatus: null,
      providerCode: null,
    },
    limitation: { ...UNPROBED, message },
  };
}

function buildDoctorData(
  dependencies: DoctorDependencies,
  configuredBaseUrl: string,
  resolvedZone: string,
  organizationId: number | null,
  scenarioId: number | null,
  capabilities: CapabilityProbe[],
  rateLimit: RateLimitSnapshot,
  authenticated: boolean,
): DoctorData {
  return {
    platform: dependencies.platform ?? `${process.platform}/${process.arch}`,
    configuredZone: zoneName(configuredBaseUrl),
    resolvedZone,
    authenticatedZones: authenticated ? [resolvedZone] : [],
    authentication: { valid: authenticated },
    organizationId,
    scenarioId,
    capabilities,
    rateLimit,
  };
}

function organizationIdFrom(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const organization = record.organization;
  const organizationRecord = organization && typeof organization === "object"
    ? organization as Record<string, unknown>
    : undefined;
  const candidate = record.organizationId ?? record.organization_id ?? organizationRecord?.id;
  const id = Number(candidate);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function zoneName(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/\.make\.com$/, "");
  } catch {
    return baseUrl;
  }
}

function renderHumanDoctor(data: DoctorData): string {
  const lines = [
    "Make Fixer doctor",
    `Platform: ${data.platform}`,
    `Configured zone: ${data.configuredZone}`,
    `Resolved zone: ${data.resolvedZone}`,
    `Authentication: ${data.authentication.valid ? "valid" : "invalid"}`,
    `Rate limit: ${data.rateLimit.effectiveRpm} rpm (${data.rateLimit.limitSource})`,
  ];
  for (const capability of data.capabilities) {
    const status = capability.probed
      ? capability.supported ? "supported" : `limited (${capability.limitation?.code})`
      : "unprobed";
    lines.push(`${capability.name}: ${status} — GET ${capability.evidence.path}`);
  }
  return lines.join("\n");
}

function inputFailure(error: unknown): ClassifiedApiError {
  return {
    code: "INVALID_DATA",
    message: error instanceof Error ? error.message : "Invalid doctor arguments.",
    httpStatus: null,
    providerCode: null,
    retryable: false,
  };
}
