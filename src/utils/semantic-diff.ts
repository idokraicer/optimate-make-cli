import type { Blueprint, Module } from "../make-api/types";
import { walkModules } from "./blueprint-traversal";

export interface LeafChange {
  path: string;
  moduleId: number | null;
  before: unknown;
  after: unknown;
}

export interface SemanticDiff {
  directlyModifiedModules: number[];
  ancestorModules: number[];
  changes: LeafChange[];
}

interface UnownedLeafChange {
  path: string;
  before: unknown;
  after: unknown;
}

interface LeafMap {
  [path: string]: unknown;
}

const missing = Symbol("missing");

function appendPath(path: string, key: string | number, array = false): string {
  return array ? `${path}[${key}]` : path ? `${path}.${key}` : String(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function flattenLeaves(value: unknown, path: string, leaves: LeafMap): void {
  if (Array.isArray(value)) {
    if (value.length === 0) leaves[path] = value;
    for (let index = 0; index < value.length; index++) {
      flattenLeaves(value[index], appendPath(path, index, true), leaves);
    }
    return;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) leaves[path] = value;
    for (const key of keys) flattenLeaves(value[key], appendPath(path, key), leaves);
    return;
  }
  leaves[path] = value;
}

function diffLeaves(before: unknown, after: unknown, path = ""): UnownedLeafChange[] {
  if (Object.is(before, after)) return [];

  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: UnownedLeafChange[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index++) {
      changes.push(...diffLeaves(
        index < before.length ? before[index] : missing,
        index < after.length ? after[index] : missing,
        appendPath(path, index, true),
      ));
    }
    return changes;
  }

  if (isRecord(before) && isRecord(after)) {
    const changes: UnownedLeafChange[] = [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      changes.push(...diffLeaves(
        key in before ? before[key] : missing,
        key in after ? after[key] : missing,
        appendPath(path, key),
      ));
    }
    return changes;
  }

  if (before === missing || after === missing || isRecord(before) || isRecord(after) || Array.isArray(before) || Array.isArray(after)) {
    const beforeLeaves: LeafMap = {};
    const afterLeaves: LeafMap = {};
    if (before !== missing) flattenLeaves(before, path, beforeLeaves);
    if (after !== missing) flattenLeaves(after, path, afterLeaves);
    return [...new Set([...Object.keys(beforeLeaves), ...Object.keys(afterLeaves)])]
      .sort()
      .filter((leafPath) => !Object.is(beforeLeaves[leafPath], afterLeaves[leafPath]))
      .map((leafPath) => ({
        path: leafPath,
        before: beforeLeaves[leafPath],
        after: afterLeaves[leafPath],
      }));
  }

  return [{ path, before, after }];
}

interface IdentifiedModule {
  id: number;
  path: string;
  module: Module;
}

function identifiedModules(blueprint: Blueprint): IdentifiedModule[] {
  const grouped = new Map<number, IdentifiedModule[]>();
  for (const walked of walkModules(blueprint.flow)) {
    if (typeof walked.module.id !== "number") continue;
    const entries = grouped.get(walked.module.id) ?? [];
    entries.push({ id: walked.module.id, path: walked.path, module: walked.module });
    grouped.set(walked.module.id, entries);
  }
  return [...grouped.values()]
    .filter((entries) => entries.length === 1)
    .map(([entry]) => entry);
}

function nullIdModules(blueprint: Blueprint): Array<Omit<IdentifiedModule, "id">> {
  return walkModules(blueprint.flow)
    .filter((walked) => walked.module.id === null)
    .map((walked) => ({ path: walked.path, module: walked.module }));
}

function routeMetadata(route: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(route).filter(([key]) => key !== "flow"));
}

function ownModuleContent(module: Module): Record<string, unknown> {
  return Object.fromEntries(Object.entries(module).flatMap(([key, value]) => {
    if (key === "onerror") return [];
    if ((key === "routes" || key === "branches") && Array.isArray(value)) {
      return [[key, value.map((route) => routeMetadata(route as Record<string, unknown>))]];
    }
    return [[key, value]];
  }));
}

function ancestorIds(path: string, modules: IdentifiedModule[]): number[] {
  return modules
    .filter((entry) => path.startsWith(`${entry.path}.`))
    .map((entry) => entry.id);
}

function moduleContainerPath(path: string): string {
  return path.replace(/\[\d+\]$/, "");
}

function reorderedModuleIds(
  beforeModules: IdentifiedModule[],
  afterModules: IdentifiedModule[],
): Set<number> {
  const beforeById = new Map(beforeModules.map((entry) => [entry.id, entry]));
  const afterById = new Map(afterModules.map((entry) => [entry.id, entry]));
  const containers = new Set<string>();

  for (const afterModule of afterModules) {
    const beforeModule = beforeById.get(afterModule.id);
    if (beforeModule && moduleContainerPath(beforeModule.path) === moduleContainerPath(afterModule.path)) {
      containers.add(moduleContainerPath(afterModule.path));
    }
  }

  const reordered = new Set<number>();
  for (const container of containers) {
    const beforeOrder = beforeModules
      .filter((entry) => {
        const afterModule = afterById.get(entry.id);
        return afterModule != null
          && moduleContainerPath(entry.path) === container
          && moduleContainerPath(afterModule.path) === container;
      })
      .map((entry) => entry.id);
    const afterOrder = afterModules
      .filter((entry) => {
        const beforeModule = beforeById.get(entry.id);
        return beforeModule != null
          && moduleContainerPath(entry.path) === container
          && moduleContainerPath(beforeModule.path) === container;
      })
      .map((entry) => entry.id);
    for (let index = 0; index < beforeOrder.length; index++) {
      if (beforeOrder[index] !== afterOrder[index]) {
        reordered.add(beforeOrder[index]);
        reordered.add(afterOrder[index]);
      }
    }
  }
  return reordered;
}

export function semanticDiff(before: Blueprint, after: Blueprint): SemanticDiff {
  const direct = new Set<number>();
  const ancestors = new Set<number>();
  const beforeModules = new Map(identifiedModules(before).map((entry) => [entry.id, entry]));
  const afterModules = identifiedModules(after);
  const beforeModuleList = [...beforeModules.values()];
  const beforeNullModules = new Map(nullIdModules(before).map((entry) => [entry.path, entry]));
  const afterNullModules = nullIdModules(after);
  const beforeTopLevel = { ...before } as Record<string, unknown>;
  const afterTopLevel = { ...after } as Record<string, unknown>;
  delete beforeTopLevel.flow;
  delete afterTopLevel.flow;

  const changes: LeafChange[] = diffLeaves(beforeTopLevel, afterTopLevel).map((change) => ({
    ...change,
    moduleId: null,
  }));

  const recordMovement = (beforeModule: IdentifiedModule, afterModule: IdentifiedModule) => {
    direct.add(afterModule.id);
    for (const ancestorId of [
      ...ancestorIds(beforeModule.path, beforeModuleList),
      ...ancestorIds(afterModule.path, afterModules),
    ]) {
      ancestors.add(ancestorId);
    }
    changes.push({
      path: afterModule.path,
      moduleId: afterModule.id,
      before: beforeModule.path,
      after: afterModule.path,
    });
  };

  for (const afterModule of afterModules) {
    const beforeModule = beforeModules.get(afterModule.id);
    if (!beforeModule) continue;
    if (moduleContainerPath(beforeModule.path) !== moduleContainerPath(afterModule.path)) {
      recordMovement(beforeModule, afterModule);
    }
    const moduleChanges = diffLeaves(
      ownModuleContent(beforeModule.module),
      ownModuleContent(afterModule.module),
      afterModule.path,
    );
    if (moduleChanges.length === 0) continue;
    direct.add(afterModule.id);
    for (const ancestorId of ancestorIds(afterModule.path, afterModules)) {
      ancestors.add(ancestorId);
    }
    changes.push(...moduleChanges.map((change) => ({ ...change, moduleId: afterModule.id })));
  }

  for (const moduleId of reorderedModuleIds(beforeModuleList, afterModules)) {
    const beforeModule = beforeModules.get(moduleId);
    const afterModule = afterModules.find((entry) => entry.id === moduleId);
    if (beforeModule && afterModule) recordMovement(beforeModule, afterModule);
  }

  for (const afterModule of afterNullModules) {
    const beforeModule = beforeNullModules.get(afterModule.path);
    if (!beforeModule) continue;
    const moduleChanges = diffLeaves(
      ownModuleContent(beforeModule.module),
      ownModuleContent(afterModule.module),
      afterModule.path,
    );
    if (moduleChanges.length === 0) continue;
    for (const ancestorId of ancestorIds(afterModule.path, afterModules)) {
      ancestors.add(ancestorId);
    }
    changes.push(...moduleChanges.map((change) => ({ ...change, moduleId: null })));
  }

  for (const moduleId of direct) ancestors.delete(moduleId);
  return {
    directlyModifiedModules: [...direct].sort((left, right) => left - right),
    ancestorModules: [...ancestors].sort((left, right) => left - right),
    changes: changes.sort((left, right) => left.path.localeCompare(right.path)),
  };
}
