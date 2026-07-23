import { dirname } from "node:path";
import type { Blueprint } from "../make-api/types";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:token|secret|password|authorization|api[-_]?key|cookie|credential)/i;
const SNIPPET_CONTEXT = 75;

export interface SearchMatch {
  scenarioId: number;
  scenarioName: string;
  teamId: number;
  moduleId: number | null;
  moduleType: string | null;
  path: string;
  key: string | null;
  value: string;
  snippet: string;
}

export interface SearchEntry {
  scenarioId: number;
  scenarioName: string;
  teamId: number;
  moduleId: number | null;
  moduleType: string | null;
  path: string;
  key: string | null;
  value: string;
}

export type SearchQuery =
  | { kind: "literal"; value: string; caseSensitive: boolean }
  | { kind: "regex"; pattern: string; caseSensitive: boolean }
  | { kind: "field"; field: string; value: string; caseSensitive: boolean };

export interface ScenarioIndexRecord {
  scenarioId: number;
  scenarioName: string;
  teamId: number;
  lastEdit: string;
  sanitizedBlueprint: Blueprint;
  entries: SearchEntry[];
  indexedAt: string;
}

export interface SearchIndexFile {
  version: 1;
  organizationId: number;
  zone: string;
  records: ScenarioIndexRecord[];
}

export interface ScenarioSummary {
  id: number;
  name?: string;
  teamId?: number;
  lastEdit?: string;
  description?: string;
}

export interface SearchIndexClient {
  fetchBlueprint(scenarioId: number): Promise<{ blueprint: Blueprint; raw: unknown }>;
  fetchNotes?(scenarioId: number): Promise<unknown[]>;
}

export interface RefreshSearchIndexOptions {
  indexPath: string;
  organizationId: number;
  zone: string;
  fresh?: boolean;
  concurrency?: number;
  pruneMissing?: boolean;
  now?: () => Date;
}

export interface RefreshSearchIndexResult {
  records: ScenarioIndexRecord[];
  cacheHits: number;
  fetchedScenarioIds: number[];
  failedScenarioIds: number[];
  incomplete: boolean;
}

export function sanitizeForIndex(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForIndex);
  if (typeof value === "string") return sanitizeSearchText(value);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const sensitivePair = [record.name, record.key, record.header]
    .some((candidate) => typeof candidate === "string" && sensitivePairName(candidate));

  return Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    SENSITIVE_KEY.test(key) || (sensitivePair && /^(?:value|values|content|defaultValue)$/i.test(key))
      ? REDACTED
      : sanitizeForIndex(child),
  ]));
}

function sensitivePairName(value: string): boolean {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  return [
    "authorization",
    "cookie",
    "setcookie",
    "xapikey",
    "apikey",
    "xauthtoken",
    "session",
    "sessionid",
  ].includes(normalized);
}

function sanitizeSearchText(value: string): string {
  return value
    .replace(/\b(authorization|cookie)\s*:\s*[^\r\n,;]+/gi, "$1: [REDACTED]")
    .replace(/\b(Basic|Bearer|Token)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\b(session(?:id)?=)[^;\s,]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    .replace(
      /(\b[A-Za-z0-9_-]*(?:token|secret|password|credential|api[-_]?key)[A-Za-z0-9_-]*\s*[:=]\s*)[^\s,;&]+/gi,
      "$1[REDACTED]",
    );
}

export function flattenSearchDocument(value: unknown, basePath = ""): SearchEntry[] {
  const entries: SearchEntry[] = [];

  const visit = (
    current: unknown,
    path: string,
    key: string | null,
    moduleId: number | null,
    moduleType: string | null,
  ): void => {
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(
        child,
        `${path}[${index}]`,
        key,
        moduleId,
        moduleType,
      ));
      return;
    }

    if (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      const ownModuleType = typeof record.module === "string" ? record.module : moduleType;
      const ownModuleId = typeof record.module === "string" && (typeof record.id === "number" || record.id === null)
        ? record.id as number | null
        : moduleId;
      for (const [childKey, child] of Object.entries(record)) {
        visit(child, path ? `${path}.${childKey}` : childKey, childKey, ownModuleId, ownModuleType);
      }
      return;
    }

    if (current === undefined) return;
    entries.push({
      scenarioId: 0,
      scenarioName: "",
      teamId: 0,
      moduleId,
      moduleType,
      path: path || basePath,
      key,
      value: current === null ? "null" : String(current),
    });
  };

  visit(value, basePath, null, null, null);
  return entries;
}

export function searchEntries(entries: SearchEntry[], query: SearchQuery): SearchMatch[] {
  let regex: RegExp | undefined;
  if (query.kind === "regex") {
    regex = new RegExp(query.pattern, query.caseSensitive ? "" : "i");
  }

  return entries.flatMap((entry) => {
    const key = entry.key ?? "";
    const normalize = (text: string) => query.caseSensitive ? text : text.toLocaleLowerCase();
    let matched = false;
    let needle = "";

    if (query.kind === "field") {
      matched = normalize(key) === normalize(query.field) && normalize(entry.value) === normalize(query.value);
      needle = query.value;
    } else if (query.kind === "regex") {
      regex!.lastIndex = 0;
      const keyMatch = regex!.exec(key);
      regex!.lastIndex = 0;
      const valueMatch = regex!.exec(entry.value);
      matched = keyMatch !== null || valueMatch !== null;
      needle = valueMatch?.[0] ?? "";
    } else {
      const wanted = normalize(query.value);
      matched = normalize(key).includes(wanted) || normalize(entry.value).includes(wanted);
      needle = normalize(entry.value).includes(wanted) ? query.value : "";
    }

    return matched ? [{
      ...entry,
      snippet: boundedSnippet(entry.value, needle, query.caseSensitive),
    }] : [];
  });
}

export async function refreshSearchIndex(
  client: SearchIndexClient,
  scenarios: ScenarioSummary[],
  options: RefreshSearchIndexOptions,
): Promise<RefreshSearchIndexResult> {
  const existing = await readIndex(options.indexPath);
  const cached = new Map(
    existing?.organizationId === options.organizationId && existing.zone === options.zone
      ? existing.records.map((record) => [record.scenarioId, record])
      : [],
  );
  const currentIds = new Set(scenarios.map((scenario) => scenario.id));
  const records = new Map<number, ScenarioIndexRecord>(
    options.pruneMissing === false
      ? cached
      : [...cached].filter(([scenarioId]) => currentIds.has(scenarioId)),
  );
  const changed: ScenarioSummary[] = [];
  let cacheHits = 0;

  for (const scenario of scenarios) {
    const previous = cached.get(scenario.id);
    if (!options.fresh && previous && previous.lastEdit === normalizeLastEdit(scenario.lastEdit)) {
      cacheHits++;
    } else {
      changed.push(scenario);
      records.delete(scenario.id);
    }
  }

  await writeIndex(options.indexPath, {
    version: 1,
    organizationId: options.organizationId,
    zone: options.zone,
    records: sortedRecords(records),
  });
  let checkpoint = Promise.resolve();
  const checkpointRecords = (): Promise<void> => {
    const snapshot = sortedRecords(records);
    checkpoint = checkpoint.then(() => writeIndex(options.indexPath, {
      version: 1,
      organizationId: options.organizationId,
      zone: options.zone,
      records: snapshot,
    }));
    return checkpoint;
  };

  const fetchedScenarioIds: number[] = [];
  const failedScenarioIds: number[] = [];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(2, options.concurrency ?? 2, changed.length || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < changed.length) {
      const scenario = changed[cursor++]!;
      try {
        const { blueprint } = await client.fetchBlueprint(scenario.id);
        const notes = await fetchOptionalNotes(client, scenario.id);
        const sanitizedBlueprint = sanitizeForIndex(blueprint) as Blueprint;
        const sanitizedNotes = sanitizeForIndex(notes);
        const document = sanitizeForIndex({
          scenario: {
            name: scenario.name ?? blueprint.name,
            description: scenario.description ?? null,
          },
          blueprint: sanitizedBlueprint,
          notes: sanitizedNotes,
        });
        const scenarioName = sanitizeSearchText(scenario.name ?? blueprint.name);
        const teamId = validPositiveInteger(scenario.teamId) ? scenario.teamId! : 0;
        const entries = flattenSearchDocument(document).map((entry) => ({
          ...entry,
          scenarioId: scenario.id,
          scenarioName,
          teamId,
        }));
        records.set(scenario.id, {
          scenarioId: scenario.id,
          scenarioName,
          teamId,
          lastEdit: normalizeLastEdit(scenario.lastEdit),
          sanitizedBlueprint,
          entries,
          indexedAt: (options.now?.() ?? new Date()).toISOString(),
        });
        fetchedScenarioIds.push(scenario.id);
        await checkpointRecords();
      } catch {
        failedScenarioIds.push(scenario.id);
      }
    }
  });
  await Promise.all(workers);

  return {
    records: sortedRecords(records),
    cacheHits,
    fetchedScenarioIds: fetchedScenarioIds.sort((a, b) => a - b),
    failedScenarioIds: failedScenarioIds.sort((a, b) => a - b),
    incomplete: failedScenarioIds.length > 0,
  };
}

async function fetchOptionalNotes(client: SearchIndexClient, scenarioId: number): Promise<unknown[]> {
  if (!client.fetchNotes) return [];
  try {
    return await client.fetchNotes(scenarioId);
  } catch {
    return [];
  }
}

async function readIndex(path: string): Promise<SearchIndexFile | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const parsed = await file.json() as Partial<SearchIndexFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) return null;
    return {
      ...(parsed as SearchIndexFile),
      records: parsed.records.map((record) => ({
        ...record,
        scenarioName: sanitizeSearchText(record.scenarioName),
        sanitizedBlueprint: sanitizeForIndex(record.sanitizedBlueprint) as Blueprint,
        entries: record.entries.map((entry) => ({
          ...sanitizeCachedEntry(entry),
          scenarioName: sanitizeSearchText(entry.scenarioName),
        })),
      })),
    };
  } catch {
    return null;
  }
}

function sanitizeCachedEntry(entry: SearchEntry): SearchEntry {
  const sensitivePath = entry.path.split(/[.[\]]+/).some((segment) => SENSITIVE_KEY.test(segment));
  return {
    ...entry,
    value: sensitivePath || (entry.key !== null && SENSITIVE_KEY.test(entry.key))
      ? REDACTED
      : sanitizeSearchText(entry.value),
  };
}

async function writeIndex(path: string, index: SearchIndexFile): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await Bun.write(temporaryPath, JSON.stringify(index, null, 2));
  await fs.rename(temporaryPath, path);
}

function sortedRecords(records: Map<number, ScenarioIndexRecord>): ScenarioIndexRecord[] {
  return [...records.values()].sort((left, right) => left.scenarioId - right.scenarioId);
}

function normalizeLastEdit(value: string | undefined): string {
  return value ?? "";
}

function validPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function boundedSnippet(value: string, needle: string, caseSensitive: boolean): string {
  if (value.length <= SNIPPET_CONTEXT * 2) return value;
  const haystack = caseSensitive ? value : value.toLocaleLowerCase();
  const wanted = caseSensitive ? needle : needle.toLocaleLowerCase();
  const index = wanted ? haystack.indexOf(wanted) : 0;
  const start = Math.max(0, index - SNIPPET_CONTEXT);
  const end = Math.min(value.length, Math.max(index + wanted.length + SNIPPET_CONTEXT, SNIPPET_CONTEXT * 2));
  return `${start > 0 ? "…" : ""}${value.slice(start, end)}${end < value.length ? "…" : ""}`;
}
