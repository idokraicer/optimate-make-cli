import type { Module } from "../make-api/types";
import {
  sanitizeForIndex,
  type ScenarioIndexRecord,
} from "../search/search-index";
import {
  walkModules,
  type ModuleContainer,
  type WalkedModule,
} from "../utils/blueprint-traversal";

const CONFIGURATION_LEAF = "<leaf>";

export interface ModuleExampleStructuralContext {
  path: string;
  container: ModuleContainer;
  depth: number;
  parentModuleId: number | null;
  parent: {
    path: string;
    id: number | null;
    module: string;
    version: number;
    name: string | null;
    metadata: unknown;
  } | null;
  containerMetadata: unknown | null;
}

export interface ModuleExampleFullDetails {
  fragment: Module;
  context: ModuleExampleStructuralContext;
}

export interface ModuleExample {
  scenarioId: number;
  scenarioName: string;
  teamId: number;
  moduleId: number;
  path: string;
  module: string;
  version: number;
  signature: string;
  equivalentCount: number;
  equivalentLocations: Array<{ scenarioId: number; moduleId: number; path: string }>;
  fragment: Module;
  full?: ModuleExampleFullDetails;
}

export interface ModuleExampleQuery {
  module?: string;
  app?: string;
  search?: string;
  version?: number;
  scenarioId?: number;
  moduleId?: number;
  full?: boolean;
}

/**
 * Remove credential-bearing values without stripping IDs, resource URLs,
 * mapper values, restore labels, or interface metadata that an agent needs to
 * reproduce an observed module configuration.
 */
export function sanitizeModuleFragment<T>(value: T): T {
  return sanitizeForIndex(value) as T;
}

export function moduleConfigurationSignature(module: Module): string {
  const shape = {
    module: module.module,
    version: module.version ?? 0,
    parameters: configurationShape(module.parameters),
    mapper: configurationShape(module.mapper),
    metadata: configurationShape(module.metadata),
  };
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(shape))
    .digest("hex");
}

export function findModuleExamples(
  records: ScenarioIndexRecord[],
  query: ModuleExampleQuery,
): ModuleExample[] {
  const candidates = records.flatMap((record) => {
    const walked = walkModules(record.sanitizedBlueprint.flow);
    return walked.flatMap((entry) => {
      const { module, path } = entry;
      if (typeof module.id !== "number") return [];
      const fragment = sanitizeModuleFragment(module);
      if (!matchesQuery(record.scenarioId, fragment, query)) return [];
      return [{
        scenarioId: record.scenarioId,
        scenarioName: record.scenarioName,
        teamId: record.teamId,
        moduleId: module.id,
        path,
        module: module.module,
        version: module.version ?? 0,
        signature: moduleConfigurationSignature(fragment),
        fragment,
        fullDetails: query.full
          ? buildFullDetails(entry, walked, fragment)
          : undefined,
      }];
    });
  });

  candidates.sort(compareCandidate);
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const groupKey = `${candidate.module}\u0000${candidate.version}\u0000${candidate.signature}`;
    const group = groups.get(groupKey);
    if (group) group.push(candidate);
    else groups.set(groupKey, [candidate]);
  }

  return [...groups.values()].map((group) => {
    const representative = group[0]!;
    const equivalentLocations = group
      .map(({ scenarioId, moduleId, path }) => ({ scenarioId, moduleId, path }))
      .sort(compareLocation);
    return {
      scenarioId: representative.scenarioId,
      scenarioName: representative.scenarioName,
      teamId: representative.teamId,
      moduleId: representative.moduleId,
      path: representative.path,
      module: representative.module,
      version: representative.version,
      signature: representative.signature,
      fragment: representative.fragment,
      equivalentCount: equivalentLocations.length,
      equivalentLocations,
      ...(representative.fullDetails ? { full: representative.fullDetails } : {}),
    };
  }).sort((left, right) =>
    left.module.localeCompare(right.module)
    || left.version - right.version
    || left.signature.localeCompare(right.signature)
  );
}

function matchesQuery(
  scenarioId: number,
  module: Module,
  query: ModuleExampleQuery,
): boolean {
  if (query.version !== undefined && (module.version ?? 0) !== query.version) return false;
  if (query.scenarioId !== undefined || query.moduleId !== undefined) {
    return scenarioId === query.scenarioId && module.id === query.moduleId;
  }
  if (query.module !== undefined) return module.module === query.module;
  if (query.app !== undefined) {
    return module.module.toLocaleLowerCase().startsWith(`${query.app.toLocaleLowerCase()}:`);
  }
  if (query.search !== undefined) {
    const searchableConfiguration = {
      parameters: module.parameters,
      mapper: module.mapper,
      filter: module.filter,
      metadata: module.metadata,
    };
    return JSON.stringify(searchableConfiguration)
      .toLocaleLowerCase()
      .includes(query.search.toLocaleLowerCase());
  }
  return false;
}

function configurationShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(configurationShape);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, configurationShape((value as Record<string, unknown>)[key])]),
    );
  }
  return CONFIGURATION_LEAF;
}

function buildFullDetails(
  entry: WalkedModule,
  walked: WalkedModule[],
  fragment: Module,
): ModuleExampleFullDetails {
  const parent = entry.parentModuleId === null
    ? null
    : walked
      .filter((candidate) =>
        candidate.module.id === entry.parentModuleId
        && entry.path.startsWith(`${candidate.path}.`)
      )
      .sort((left, right) => right.path.length - left.path.length)[0] ?? null;

  return sanitizeModuleFragment({
    fragment,
    context: {
      path: entry.path,
      container: entry.container,
      depth: entry.depth,
      parentModuleId: entry.parentModuleId,
      parent: parent ? {
        path: parent.path,
        id: parent.module.id,
        module: parent.module.module,
        version: parent.module.version ?? 0,
        name: parent.module.name ?? null,
        metadata: parent.module.metadata ?? {},
      } : null,
      containerMetadata: immediateContainerMetadata(entry, parent),
    },
  });
}

function immediateContainerMetadata(
  entry: WalkedModule,
  parent: WalkedModule | null,
): unknown | null {
  if (!parent || (entry.container !== "route" && entry.container !== "branch")) return null;
  const property = entry.container === "route" ? "routes" : "branches";
  const directPath = new RegExp(
    `^${escapeRegExp(parent.path)}\\.${property}\\[(\\d+)\\]\\.flow\\[\\d+\\]$`,
  );
  const match = entry.path.match(directPath);
  if (!match) return null;
  const container = parent.module[property]?.[Number(match[1])];
  if (!container || typeof container !== "object") return null;
  const { flow: _flow, ...metadata } = container;
  return metadata;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareCandidate(
  left: { scenarioId: number; moduleId: number; path: string },
  right: { scenarioId: number; moduleId: number; path: string },
): number {
  return compareLocation(left, right);
}

function compareLocation(
  left: { scenarioId: number; moduleId: number; path: string },
  right: { scenarioId: number; moduleId: number; path: string },
): number {
  return left.scenarioId - right.scenarioId
    || left.moduleId - right.moduleId
    || left.path.localeCompare(right.path);
}
