import type { Command } from "commander";
import type { MakeApiClient } from "../make-api/client";
import type { Blueprint, Module } from "../make-api/types";
import { failureEnvelope, successEnvelope } from "./output";
import {
  findWalkedModulesById,
  walkModules,
  type ModuleContainer,
  type WalkedModule,
} from "../utils/blueprint-traversal";
import { getMaxModuleId, getModuleCustomName } from "../utils/module-helpers";

export interface InspectModuleData {
  id: number | null;
  path: string;
  type: string;
  name: string | null;
  container: ModuleContainer;
  parentModuleId: number | null;
  mapper: unknown;
  parameters: unknown;
  resolvedLabels: Record<string, string>;
}

export interface InspectSummaryModuleData {
  id: number | null;
  path: string;
  type: string;
  name: string | null;
  container: ModuleContainer;
  parentModuleId: number | null;
}

export interface InspectSummaryData {
  name: string;
  modules: InspectSummaryModuleData[];
  moduleCount: number;
  maxModuleId: number;
  nextModuleId: number;
  trigger: Pick<InspectSummaryModuleData, "id" | "path" | "type" | "name"> | null;
  containerCounts: Record<ModuleContainer, number>;
}

export interface InspectModuleResult {
  scenarioId: number;
  source: "remote" | "local";
  module: InspectModuleData;
}

export interface InspectSummaryResult {
  scenarioId: number;
  source: "remote" | "local";
  summary: InspectSummaryData;
}

export type InspectResult = InspectModuleResult | InspectSummaryResult;

export class DuplicateModuleIdsError extends Error {
  constructor(readonly duplicates: Record<string, string[]>) {
    super("Blueprint contains duplicate module IDs.");
    this.name = "DuplicateModuleIdsError";
  }
}

export class InspectInputError extends Error {
  constructor(message: string, readonly legacyDiagnostics: string[] = []) {
    super(message);
    this.name = "InspectInputError";
  }
}

type InspectOptions = {
  moduleId?: number;
  summary?: boolean;
  source: "remote" | "local";
};

type ModuleLookupOptions = Omit<InspectOptions, "moduleId" | "summary"> & {
  moduleId: number;
  summary?: false | undefined;
};

type SummaryOptions = Omit<InspectOptions, "moduleId" | "summary"> & {
  moduleId?: undefined;
  summary: true;
};

export function inspectBlueprint(
  blueprint: Blueprint,
  scenarioId: number,
  options: ModuleLookupOptions,
): InspectModuleResult;
export function inspectBlueprint(
  blueprint: Blueprint,
  scenarioId: number,
  options: SummaryOptions,
): InspectSummaryResult;
export function inspectBlueprint(
  blueprint: Blueprint,
  scenarioId: number,
  options: InspectOptions,
): InspectResult;
export function inspectBlueprint(
  blueprint: Blueprint,
  scenarioId: number,
  options: InspectOptions,
): InspectResult {
  const duplicates = findDuplicateModuleIds(blueprint);
  if (Object.keys(duplicates).length > 0) throw new DuplicateModuleIdsError(duplicates);

  if (options.moduleId !== undefined) {
    const matches = findWalkedModulesById(blueprint.flow, options.moduleId);
    if (matches.length === 0) {
      throw new Error(`Module #${options.moduleId} was not found.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Module #${options.moduleId} is ambiguous at paths: ${matches.map(({ path }) => path).join(", ")}`,
      );
    }

    return {
      scenarioId,
      source: options.source,
      module: toInspectModuleData(matches[0]),
    };
  }

  const modules = walkModules(blueprint.flow);
  const maxModuleId = getMaxModuleId(blueprint.flow);
  const containerCounts: Record<ModuleContainer, number> = {
    flow: 0,
    route: 0,
    branch: 0,
    onerror: 0,
  };
  for (const entry of modules) containerCounts[entry.container]++;

  const trigger = modules.find((entry) => entry.path === "flow[0]");
  return {
    scenarioId,
    source: options.source,
    summary: {
      name: blueprint.name,
      modules: modules.map(toInspectSummaryModuleData),
      moduleCount: modules.length,
      maxModuleId,
      nextModuleId: maxModuleId + 1,
      trigger: trigger ? {
        id: trigger.module.id,
        path: trigger.path,
        type: trigger.module.module,
        name: moduleName(trigger.module),
      } : null,
      containerCounts,
    },
  };
}

function findDuplicateModuleIds(blueprint: Blueprint): Record<string, string[]> {
  const pathsById = new Map<number, string[]>();
  for (const { module, path } of walkModules(blueprint.flow)) {
    if (typeof module.id !== "number") continue;
    const paths = pathsById.get(module.id) ?? [];
    paths.push(path);
    pathsById.set(module.id, paths);
  }

  return Object.fromEntries(
    [...pathsById.entries()]
      .filter(([, paths]) => paths.length > 1)
      .sort(([left], [right]) => left - right)
      .map(([id, paths]) => [String(id), paths]),
  );
}

function toInspectModuleData(entry: WalkedModule): InspectModuleData {
  return {
    id: entry.module.id,
    path: entry.path,
    type: entry.module.module,
    name: moduleName(entry.module),
    container: entry.container,
    parentModuleId: entry.parentModuleId,
    mapper: entry.module.mapper ?? null,
    parameters: entry.module.parameters ?? null,
    resolvedLabels: extractRestoreLabels(entry.module),
  };
}

function toInspectSummaryModuleData(entry: WalkedModule): InspectSummaryModuleData {
  return {
    id: entry.module.id,
    path: entry.path,
    type: entry.module.module,
    name: moduleName(entry.module),
    container: entry.container,
    parentModuleId: entry.parentModuleId,
  };
}

function moduleName(module: Module): string | null {
  return getModuleCustomName(module) ?? module.name ?? null;
}

function extractRestoreLabels(module: Module): Record<string, string> {
  const labels: Record<string, string> = {};
  const expect = (module.metadata as Record<string, unknown> | undefined)?.restore;
  const value = expect && typeof expect === "object"
    ? (expect as Record<string, unknown>).expect
    : undefined;

  visitRestoreExpect(value, undefined, labels);
  return labels;
}

function visitRestoreExpect(
  value: unknown,
  key: string | undefined,
  labels: Record<string, string>,
): void {
  if (typeof value === "string") {
    if (key) labels[key] = value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitRestoreExpect(item, key, labels);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label : undefined;
  const explicitKey = [record.name, record.key, record.id]
    .find((candidate): candidate is string => typeof candidate === "string");
  if (label && (explicitKey ?? key)) labels[explicitKey ?? key!] = label;

  for (const [childKey, childValue] of Object.entries(record)) {
    if (childKey !== "label" && childKey !== "name" && childKey !== "key" && childKey !== "id") {
      visitRestoreExpect(childValue, childKey, labels);
    }
  }
}

type InspectDependencies = {
  resolveClient: (
    scenarioId: number,
    baseUrlOverride?: string,
    teamId?: number,
  ) => Promise<Pick<MakeApiClient, "fetchBlueprint">>;
  parseScenarioInput: (input: string) => {
    scenarioId: number;
    teamId?: number;
    baseUrl?: string;
  };
  readLocalBlueprint: (scenarioId: number) => Promise<Blueprint>;
  cliVersion: string;
};

export function registerInspectCommand(program: Command, dependencies: InspectDependencies): void {
  program
    .command("inspect")
    .description("Inspect a scenario summary or exact module configuration")
    .option("-s, --scenario [id]", "Make.com scenario ID or URL")
    .option("--module [id]", "Inspect one module by ID")
    .option("--summary", "Inspect every module and safe next ID")
    .option("--local", "Read blueprints/<scenarioId>.json instead of fetching")
    .option("--human", "Render a readable summary instead of the default JSON")
    .action(async (opts) => {
      try {
        const { scenarioId, teamId, baseUrl } = dependencies.parseScenarioInput(opts.scenario);
        const moduleId = validateInspectMode(opts);
        const source = opts.local ? "local" as const : "remote" as const;
        const blueprint = opts.local
          ? await dependencies.readLocalBlueprint(scenarioId)
          : (await (await dependencies.resolveClient(scenarioId, baseUrl, teamId)).fetchBlueprint(scenarioId)).blueprint;
        const result = moduleId === undefined
          ? inspectBlueprint(blueprint, scenarioId, { summary: true, source })
          : inspectBlueprint(blueprint, scenarioId, { moduleId, source });

        if (opts.human) {
          printHumanInspectResult(result);
          return;
        }

        console.log(JSON.stringify(successEnvelope("inspect", result, {
          cliVersion: dependencies.cliVersion,
          source,
          verifiedAt: new Date().toISOString(),
          scenarioId,
        }), null, 2));
      } catch (error) {
        const safeError = inspectFailure(error);
        console.log(JSON.stringify(failureEnvelope("inspect", safeError), null, 2));
        process.exitCode = 1;
      }
    });
}

function validateInspectMode(opts: { module?: unknown; summary?: boolean }): number | undefined {
  const hasModule = opts.module !== undefined;
  if (hasModule === Boolean(opts.summary)) {
    throw new InspectInputError("Choose exactly one of --module or --summary.");
  }
  if (!hasModule) return undefined;
  if (typeof opts.module !== "string") {
    throw new InspectInputError("--module must be a positive integer.");
  }

  const moduleId = Number(opts.module);
  if (!Number.isInteger(moduleId) || moduleId <= 0) {
    throw new InspectInputError("--module must be a positive integer.");
  }
  return moduleId;
}

function inspectFailure(error: unknown): {
  code: "INVALID_DATA";
  message: string;
  httpStatus: null;
  providerCode: null;
  retryable: false;
  duplicates?: Record<string, string[]>;
} {
  if (error instanceof DuplicateModuleIdsError) {
    return {
      code: "INVALID_DATA",
      message: error.message,
      httpStatus: null,
      providerCode: null,
      retryable: false,
      duplicates: error.duplicates,
    };
  }
  if (error instanceof InspectInputError || (error instanceof Error && error.message.startsWith("Module #"))) {
    return {
      code: "INVALID_DATA",
      message: error.message,
      httpStatus: null,
      providerCode: null,
      retryable: false,
    };
  }
  return {
    code: "INVALID_DATA",
    message: "Unable to inspect scenario.",
    httpStatus: null,
    providerCode: null,
    retryable: false,
  };
}

function printHumanInspectResult(result: InspectResult): void {
  if ("module" in result) {
    console.log(`${result.source} scenario ${result.scenarioId}: #${result.module.id} ${result.module.type}`);
    console.log(`Path: ${result.module.path} (${result.module.container})`);
    return;
  }

  const { summary } = result;
  console.log(`${result.source} scenario ${result.scenarioId}: ${summary.name}`);
  console.log(`Modules: ${summary.moduleCount} | Max ID: ${summary.maxModuleId} | Next ID: ${summary.nextModuleId}`);
}
