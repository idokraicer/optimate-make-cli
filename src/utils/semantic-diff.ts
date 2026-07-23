import type { Blueprint } from "../make-api/types";
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

function moduleOwner(
  path: string,
  before: Blueprint,
  after: Blueprint,
): { moduleId: number | null; parentModuleId: number | null } {
  const candidates = [...walkModules(before.flow), ...walkModules(after.flow)]
    .filter((walked) => path === walked.path || path.startsWith(`${walked.path}.`))
    .sort((left, right) => right.path.length - left.path.length);
  const owner = candidates[0];
  return {
    moduleId: owner?.module.id ?? null,
    parentModuleId: owner?.parentModuleId ?? null,
  };
}

export function semanticDiff(before: Blueprint, after: Blueprint): SemanticDiff {
  const direct = new Set<number>();
  const ancestors = new Set<number>();
  const changes = diffLeaves(before, after).map((change) => {
    const owner = moduleOwner(change.path, before, after);
    if (typeof owner.moduleId === "number") direct.add(owner.moduleId);
    if (typeof owner.parentModuleId === "number") ancestors.add(owner.parentModuleId);
    return { ...change, moduleId: owner.moduleId };
  });

  for (const moduleId of direct) ancestors.delete(moduleId);
  return {
    directlyModifiedModules: [...direct].sort((left, right) => left - right),
    ancestorModules: [...ancestors].sort((left, right) => left - right),
    changes,
  };
}
