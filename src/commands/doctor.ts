import type { Command } from "commander";
import type { ClassifiedApiError } from "../make-api/api-error";
import { classifyApiResponse } from "../make-api/api-error";
import type { MakeApiClient } from "../make-api/client";
import type { RateLimitSnapshot } from "../make-api/rate-limiter";
import { failureEnvelope, successEnvelope } from "./output";

const KNOWN_ZONE_URLS = [
  "https://eu1.make.com",
  "https://eu2.make.com",
  "https://us1.make.com",
  "https://us2.make.com",
];

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

export interface ZoneProbe extends CapabilityProbe {
  zone: string;
}

export interface DoctorData {
  platform: string;
  configuredZone: string;
  resolvedZone: string | null;
  authenticatedZones: string[];
  authentication: {
    valid: boolean | null;
    status: "valid" | "invalid" | "unknown";
  };
  organizationId: number | null;
  scenarioId: number | null;
  zoneProbes: ZoneProbe[];
  capabilities: CapabilityProbe[];
  rateLimit: RateLimitSnapshot & {
    discoveryRequests: number;
  };
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
  "getScenarioUrl" | "diagnosticGet" | "getRateLimitSnapshot"
>;

type DoctorDependencies = {
  createClient: (baseUrl?: string) => Promise<DoctorClient>;
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

type ProbeResult = {
  probe: CapabilityProbe;
  payload: unknown;
};

type BareScenarioResolution = {
  client: DoctorClient;
  resolvedBaseUrl: string | null;
  scenario: ProbeResult | null;
  zoneProbes: ZoneProbe[];
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
        emit(failureEnvelope("doctor", inputFailure(error)));
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

  const configuredBaseUrl = normalizeBaseUrl(await dependencies.configuredBaseUrl());
  let parsed: ParsedMakeUrl = {};
  let scenarioInput: ScenarioInput | undefined;

  if (opts.scenario) {
    scenarioInput = dependencies.parseScenarioInput(opts.scenario);
    parsed = {
      baseUrl: scenarioInput.baseUrl,
      teamId: scenarioInput.teamId,
      scenarioId: scenarioInput.scenarioId,
    };
  } else if (opts.fromUrl) {
    parsed = dependencies.parseMakeUrl(opts.fromUrl);
    if (!parsed.baseUrl) throw new Error("--from-url must be a valid Make.com URL.");
    if (parsed.scenarioId) {
      scenarioInput = {
        scenarioId: parsed.scenarioId,
        teamId: parsed.teamId,
        baseUrl: parsed.baseUrl,
      };
    }
  }

  let client: DoctorClient;
  let resolvedBaseUrl: string | null;
  let scenarioResult: ProbeResult | null = null;
  let zoneProbes: ZoneProbe[] = [];

  if (scenarioInput && !scenarioInput.baseUrl) {
    const resolution = await resolveBareScenario(
      scenarioInput.scenarioId,
      configuredBaseUrl,
      dependencies.createClient,
    );
    client = resolution.client;
    resolvedBaseUrl = resolution.resolvedBaseUrl;
    scenarioResult = resolution.scenario;
    zoneProbes = resolution.zoneProbes;
  } else {
    resolvedBaseUrl = normalizeBaseUrl(parsed.baseUrl ?? configuredBaseUrl);
    client = await dependencies.createClient(resolvedBaseUrl);
  }

  const resolvedZone = resolvedBaseUrl ? zoneName(resolvedBaseUrl) : null;
  const capabilities: CapabilityProbe[] = [];
  const authenticationProbe = await probeEndpoint(
    "organizations.list",
    "/api/v2/organizations",
    () => client.diagnosticGet("/api/v2/organizations"),
  );
  capabilities.push(authenticationProbe.probe);
  const authentication = authenticationFrom(authenticationProbe.probe);

  let organizationId = parsed.organizationId ?? null;
  let teamId = parsed.teamId ?? null;

  if (scenarioInput && !scenarioResult && resolvedBaseUrl) {
    scenarioResult = await probeEndpoint(
      "scenarios.read",
      `/api/v2/scenarios/${scenarioInput.scenarioId}`,
      () => client.diagnosticGet(`/api/v2/scenarios/${scenarioInput!.scenarioId}`),
    );
  }

  if (scenarioResult?.probe.supported) {
    organizationId ??= organizationIdFrom(scenarioResult.payload);
    teamId ??= teamIdFrom(scenarioResult.payload);
  }

  if (authentication.valid === false) {
    appendContextProbes(
      capabilities,
      { ...parsed, teamId: teamId ?? undefined },
      scenarioInput,
      organizationId,
      "Not probed because authentication is invalid.",
    );
    return buildDoctorData(
      dependencies,
      configuredBaseUrl,
      resolvedZone,
      organizationId,
      scenarioInput?.scenarioId ?? null,
      zoneProbes,
      capabilities,
      client.getRateLimitSnapshot(),
      authentication,
    );
  }

  if (teamId) {
    const team = await probeEndpoint(
      "teams.read",
      `/api/v2/teams/${teamId}`,
      () => client.diagnosticGet(`/api/v2/teams/${teamId}`),
    );
    capabilities.push(team.probe);
    if (team.probe.supported) {
      organizationId ??= organizationIdFrom(team.payload);
    }
  }

  if (organizationId) {
    capabilities.push((await probeEndpoint(
      "organizations.read",
      `/api/v2/organizations/${organizationId}`,
      () => client.diagnosticGet(
        `/api/v2/organizations/${organizationId}`,
        organizationId!,
      ),
    )).probe);
  } else {
    capabilities.push(unprobed(
      "organizations.read",
      "/api/v2/organizations/{organizationId}",
      "Not probed because no organization ID could be resolved.",
    ));
  }

  if (scenarioInput) {
    if (scenarioResult) {
      capabilities.push(scenarioResult.probe);
    } else {
      capabilities.push(unprobed(
        "scenarios.read",
        `/api/v2/scenarios/${scenarioInput.scenarioId}`,
        "Not probed because the scenario zone could not be resolved.",
      ));
    }

    if (resolvedBaseUrl && scenarioResult?.probe.supported) {
      capabilities.push((await probeEndpoint(
        "blueprints.read",
        `/api/v2/scenarios/${scenarioInput.scenarioId}/blueprint`,
        () => client.diagnosticGet(
          `/api/v2/scenarios/${scenarioInput!.scenarioId}/blueprint`,
          organizationId ?? "unknown",
        ),
      )).probe);
      capabilities.push((await probeEndpoint(
        "scenario_interface.read",
        `/api/v2/scenarios/${scenarioInput.scenarioId}/interface`,
        () => client.diagnosticGet(
          `/api/v2/scenarios/${scenarioInput!.scenarioId}/interface`,
          organizationId ?? "unknown",
        ),
      )).probe);
    } else {
      const message = "Not probed because scenario read access was not established.";
      capabilities.push(
        unprobed(
          "blueprints.read",
          `/api/v2/scenarios/${scenarioInput.scenarioId}/blueprint`,
          message,
        ),
        unprobed(
          "scenario_interface.read",
          `/api/v2/scenarios/${scenarioInput.scenarioId}/interface`,
          message,
        ),
      );
    }
  } else {
    appendUnprobedScenarioCapabilities(capabilities);
  }

  return buildDoctorData(
    dependencies,
    configuredBaseUrl,
    resolvedZone,
    organizationId,
    scenarioInput?.scenarioId ?? null,
    zoneProbes,
    capabilities,
    client.getRateLimitSnapshot(),
    authentication,
  );
}

async function resolveBareScenario(
  scenarioId: number,
  configuredBaseUrl: string,
  createClient: DoctorDependencies["createClient"],
): Promise<BareScenarioResolution> {
  const zoneUrls = [
    configuredBaseUrl,
    ...KNOWN_ZONE_URLS.filter((url) => url !== configuredBaseUrl),
  ];
  const zoneProbes: ZoneProbe[] = [];
  let configuredClient: DoctorClient | null = null;

  for (const baseUrl of zoneUrls) {
    const client = await createClient(baseUrl);
    configuredClient ??= client;
    const result = await probeEndpoint(
      "scenarios.resolve_zone",
      `/api/v2/scenarios/${scenarioId}`,
      () => client.diagnosticGet(`/api/v2/scenarios/${scenarioId}`),
    );
    zoneProbes.push({ zone: zoneName(baseUrl), ...result.probe });
    if (result.probe.supported) {
      return {
        client,
        resolvedBaseUrl: baseUrl,
        scenario: {
          ...result,
          probe: { ...result.probe, name: "scenarios.read" },
        },
        zoneProbes,
      };
    }
  }

  return {
    client: configuredClient ?? await createClient(configuredBaseUrl),
    resolvedBaseUrl: null,
    scenario: resolutionFailure(zoneProbes),
    zoneProbes,
  };
}

function resolutionFailure(zoneProbes: ZoneProbe[]): ProbeResult | null {
  const priority = (probe: ZoneProbe): number => {
    switch (probe.limitation?.code) {
      case "TRANSIENT":
      case "RATE_LIMITED":
      case "UNKNOWN_API_ERROR":
        return 0;
      case "AUTH_INVALID":
      case "SCOPE_MISSING":
      case "PLAN_RESTRICTED":
        return 1;
      case "NOT_FOUND":
        return 2;
      default:
        return 3;
    }
  };
  const selected = [...zoneProbes].sort((left, right) => priority(left) - priority(right))[0];
  if (!selected) return null;
  const { zone: _zone, ...probe } = selected;
  return {
    payload: undefined,
    probe: { ...probe, name: "scenarios.read" },
  };
}

async function probeEndpoint(
  name: string,
  path: string,
  request: () => Promise<Response>,
): Promise<ProbeResult> {
  try {
    const response = await request();
    if (!response.ok) {
      const limitation = await classifyApiResponse(response);
      return {
        payload: await readResponseJson(response),
        probe: {
          name,
          probed: true,
          supported: false,
          evidence: {
            method: "GET",
            path,
            httpStatus: response.status || null,
            providerCode: limitation.providerCode,
          },
          limitation,
        },
      };
    }

    const payload = await readResponseJson(response);
    return {
      payload,
      probe: {
        name,
        probed: true,
        supported: true,
        evidence: {
          method: "GET",
          path,
          httpStatus: response.status || null,
          providerCode: safeProviderCode(payload),
        },
      },
    };
  } catch {
    const limitation: ClassifiedApiError = {
      code: "TRANSIENT",
      message: "The Make API probe failed before receiving an HTTP response.",
      httpStatus: null,
      providerCode: null,
      retryable: true,
    };
    return {
      payload: undefined,
      probe: {
        name,
        probed: true,
        supported: false,
        evidence: {
          method: "GET",
          path,
          httpStatus: null,
          providerCode: null,
        },
        limitation,
      },
    };
  }
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    return undefined;
  }
}

function safeProviderCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const error = record.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : undefined;
  const candidate = record.providerCode ?? record.code ?? error?.providerCode ?? error?.code;
  return typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(candidate)
    ? candidate
    : null;
}

function authenticationFrom(probe: CapabilityProbe): DoctorData["authentication"] {
  if (probe.supported) return { valid: true, status: "valid" };
  switch (probe.limitation?.code) {
    case "AUTH_INVALID":
      return { valid: false, status: "invalid" };
    case "TRANSIENT":
    case "UNKNOWN_API_ERROR":
      return { valid: null, status: "unknown" };
    default:
      return { valid: true, status: "valid" };
  }
}

function appendContextProbes(
  capabilities: CapabilityProbe[],
  parsed: ParsedMakeUrl,
  scenario: ScenarioInput | undefined,
  organizationId: number | null,
  message: string,
): void {
  if (parsed.teamId) {
    capabilities.push(unprobed("teams.read", `/api/v2/teams/${parsed.teamId}`, message));
  }
  capabilities.push(unprobed(
    "organizations.read",
    organizationId || parsed.organizationId
      ? `/api/v2/organizations/${organizationId ?? parsed.organizationId}`
      : "/api/v2/organizations/{organizationId}",
    message,
  ));
  if (scenario) appendUnprobedScenarioCapabilities(capabilities, scenario.scenarioId, message);
  else appendUnprobedScenarioCapabilities(capabilities);
}

function appendUnprobedScenarioCapabilities(
  capabilities: CapabilityProbe[],
  scenarioId?: number,
  overrideMessage?: string,
): void {
  const id = scenarioId ?? "{scenarioId}";
  const message = overrideMessage ?? (scenarioId
    ? "Not probed because scenario read access was not established."
    : "Not probed because no scenario ID was supplied.");
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
  resolvedZone: string | null,
  organizationId: number | null,
  scenarioId: number | null,
  zoneProbes: ZoneProbe[],
  capabilities: CapabilityProbe[],
  rateLimit: RateLimitSnapshot,
  authentication: DoctorData["authentication"],
): DoctorData {
  return {
    platform: dependencies.platform ?? `${process.platform}/${process.arch}`,
    configuredZone: zoneName(configuredBaseUrl),
    resolvedZone,
    authenticatedZones: authentication.valid === true && resolvedZone ? [resolvedZone] : [],
    authentication,
    organizationId,
    scenarioId,
    zoneProbes,
    capabilities,
    rateLimit: {
      ...rateLimit,
      discoveryRequests: zoneProbes.length,
    },
  };
}

function unwrapPayload(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record[key] ?? record.response ?? value;
}

function organizationIdFrom(value: unknown): number | null {
  const source = unwrapPayload(value, "team");
  const scenario = unwrapPayload(value, "scenario");
  for (const candidateValue of [source, scenario]) {
    if (!candidateValue || typeof candidateValue !== "object") continue;
    const record = candidateValue as Record<string, unknown>;
    const organization = record.organization;
    const organizationRecord = organization && typeof organization === "object"
      ? organization as Record<string, unknown>
      : undefined;
    const candidate = record.organizationId ?? record.organization_id ?? organizationRecord?.id;
    const id = Number(candidate);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

function teamIdFrom(value: unknown): number | null {
  const source = unwrapPayload(value, "scenario");
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  const team = record.team;
  const teamRecord = team && typeof team === "object" ? team as Record<string, unknown> : undefined;
  const id = Number(record.teamId ?? record.team_id ?? teamRecord?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
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
    `Resolved zone: ${data.resolvedZone ?? "unresolved"}`,
    `Authentication: ${data.authentication.status}`,
    `Rate limit: ${data.rateLimit.effectiveRpm} rpm (${data.rateLimit.limitSource})`,
  ];
  for (const zoneProbe of data.zoneProbes) {
    lines.push(
      `zone ${zoneProbe.zone}: ${zoneProbe.supported ? "found" : zoneProbe.limitation?.code}`
      + ` — GET ${zoneProbe.evidence.path} (${zoneProbe.evidence.httpStatus ?? "no response"})`,
    );
  }
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
