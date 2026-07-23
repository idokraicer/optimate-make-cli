import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Blueprint } from "../make-api/types";
import {
  flattenSearchDocument,
  refreshSearchIndex,
  sanitizeForIndex,
  searchEntries,
  type ScenarioIndexRecord,
} from "./search-index";

const blueprint = (value: string): Blueprint => ({
  name: "חיפוש לקוחות",
  flow: [{
    id: 1,
    module: "monday:CreateItemV2",
    parameters: { boardId: 5100313109, apiKey: "do-not-store" },
    mapper: {
      prompt: value,
      authorization: "Bearer hidden",
      branches: [{ flow: [{ id: 2, module: "builtin:BasicFeeder", mapper: { text: "עברית" } }] }],
    },
  }],
});

describe("search index primitives", () => {
  test("redacts sensitive keys recursively before flattening", () => {
    const sanitized = sanitizeForIndex({
      token: "one",
      nested: {
        secret: "two",
        accessToken: "two-and-a-half",
        password: "three",
        authorization: "four",
        apiKey: "five",
        cookie: "six",
        credentials: { username: "seven" },
        header: "Authorization: Basic eight",
        bearer: "Bearer nine",
        safe: "visible",
      },
    });

    expect(JSON.stringify(sanitized)).not.toMatch(/one|two|three|four|five|six|seven|eight|nine/);
    expect(sanitized).toMatchObject({
      token: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", credentials: "[REDACTED]", safe: "visible" },
    });
  });

  test("redacts values paired with sensitive Make header names before flattening", () => {
    const raw = blueprint("safe");
    raw.flow[0].mapper.headers = [
      { name: "Authorization", value: "Basic dXNlcjpwYXNz" },
      { key: "Cookie", value: "session=private-session" },
      { name: "X-API-Key", value: "sk-live-private" },
      { name: "Content-Type", value: "application/json" },
    ];

    const sanitized = sanitizeForIndex(raw) as Blueprint;
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toMatch(/dXNlcjpwYXNz|private-session|sk-live-private/);
    expect(sanitized.flow[0].mapper.headers).toEqual([
      { name: "Authorization", value: "[REDACTED]" },
      { key: "Cookie", value: "[REDACTED]" },
      { name: "X-API-Key", value: "[REDACTED]" },
      { name: "Content-Type", value: "application/json" },
    ]);
    expect(flattenSearchDocument(sanitized).map((entry) => entry.value).join(" "))
      .not.toMatch(/dXNlcjpwYXNz|private-session|sk-live-private/);
  });

  test("flattens nested module context and matches keys, values, Hebrew, regex, and exact fields", () => {
    const entries = flattenSearchDocument(sanitizeForIndex(blueprint("Send Customer")));
    const enriched = entries.map((entry) => ({
      ...entry,
      scenarioId: 44,
      scenarioName: "חיפוש לקוחות",
      teamId: 7,
    }));

    expect(enriched.find((entry) => entry.key === "boardId")).toMatchObject({
      moduleId: 1,
      moduleType: "monday:CreateItemV2",
      value: "5100313109",
    });
    expect(enriched.some((entry) => entry.moduleId === 2 && entry.value === "עברית")).toBe(true);
    expect(searchEntries(enriched, { kind: "literal", value: "boardId", caseSensitive: false })).toHaveLength(1);
    expect(searchEntries(enriched, { kind: "literal", value: "send customer", caseSensitive: false })).toHaveLength(1);
    expect(searchEntries(enriched, { kind: "literal", value: "send customer", caseSensitive: true })).toHaveLength(0);
    expect(searchEntries(enriched, { kind: "regex", pattern: "^monday:.*V2$", caseSensitive: false })).toHaveLength(1);
    expect(searchEntries(enriched, { kind: "field", field: "boardId", value: "5100313109", caseSensitive: false })).toHaveLength(1);
    expect(searchEntries(enriched, { kind: "field", field: "board", value: "5100313109", caseSensitive: false })).toHaveLength(0);
  });

  test("bounds snippets around long matched values", () => {
    const long = `${"a".repeat(200)}NEEDLE${"z".repeat(200)}`;
    const [match] = searchEntries([{
      scenarioId: 1,
      scenarioName: "one",
      teamId: 2,
      moduleId: null,
      moduleType: null,
      path: "description",
      key: "description",
      value: long,
    }], { kind: "literal", value: "NEEDLE", caseSensitive: true });
    expect(match!.snippet.length).toBeLessThanOrEqual(163);
    expect(match!.snippet).toContain("NEEDLE");
  });
});

describe("refreshSearchIndex", () => {
  test("refetches only changed scenarios, prunes removed records, and checkpoints each success", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-search-"));
    const path = join(directory, "index.json");
    const cached = (id: number, lastEdit: string): ScenarioIndexRecord => ({
      scenarioId: id,
      scenarioName: `scenario ${id}`,
      teamId: 3,
      lastEdit,
      sanitizedBlueprint: blueprint(`cached ${id}`),
      entries: [{
        scenarioId: id,
        scenarioName: `scenario ${id}`,
        teamId: 3,
        moduleId: 1,
        moduleType: "http:ActionSendData",
        path: "blueprint.flow[0].mapper.header",
        key: "header",
        value: "Bearer cache-secret",
      }],
      indexedAt: "2026-01-01T00:00:00.000Z",
    });
    await Bun.write(path, JSON.stringify({
      version: 1,
      organizationId: 9,
      zone: "eu1",
      records: [cached(1, "same"), cached(2, "old"), cached(3, "old"), cached(99, "removed")],
    }));
    const fetched: number[] = [];
    const client = {
      fetchBlueprint: async (id: number) => {
        fetched.push(id);
        if (id === 3) throw new Error("forbidden");
        const fresh = blueprint(`fresh ${id}`);
        fresh.flow[0].mapper.headers = [
          { name: "Authorization", value: "Basic persisted-private" },
          { key: "X-API-Key", value: "sk-persisted-private" },
        ];
        return { blueprint: fresh, raw: { secret: "must-not-persist" } };
      },
      fetchNotes: async () => [],
    };

    const result = await refreshSearchIndex(client, [
      { id: 1, name: "one", teamId: 3, lastEdit: "same" },
      { id: 2, name: "two", teamId: 3, lastEdit: "changed" },
      { id: 3, name: "three", teamId: 3, lastEdit: "new" },
    ], {
      indexPath: path,
      organizationId: 9,
      zone: "eu1",
      concurrency: 2,
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    });

    expect(fetched.sort()).toEqual([2, 3]);
    expect(result.cacheHits).toBe(1);
    expect(result.failedScenarioIds).toEqual([3]);
    expect(result.incomplete).toBe(true);
    expect(result.records.map((record) => record.scenarioId).sort()).toEqual([1, 2]);
    const persisted = await Bun.file(path).text();
    expect(persisted).not.toContain("must-not-persist");
    expect(persisted).not.toContain("removed");
    expect(persisted).not.toContain("do-not-store");
    expect(persisted).not.toContain("cache-secret");
    expect(persisted).not.toContain("persisted-private");
    expect(persisted).toContain("[REDACTED]");
  });

  test("retains unseen cached scenarios when organization listing is incomplete", async () => {
    const directory = mkdtempSync(join(tmpdir(), "make-fixer-search-partial-list-"));
    const path = join(directory, "index.json");
    const unseen: ScenarioIndexRecord = {
      scenarioId: 99,
      scenarioName: "Unseen cached",
      teamId: 4,
      lastEdit: "cached",
      sanitizedBlueprint: blueprint("retain me"),
      entries: [],
      indexedAt: "2026-01-01T00:00:00.000Z",
    };
    await Bun.write(path, JSON.stringify({
      version: 1,
      organizationId: 9,
      zone: "eu1",
      records: [unseen],
    }));

    const result = await refreshSearchIndex({
      fetchBlueprint: async () => ({ blueprint: blueprint("seen"), raw: {} }),
    }, [{ id: 1, name: "Seen", teamId: 4, lastEdit: "new" }], {
      indexPath: path,
      organizationId: 9,
      zone: "eu1",
      pruneMissing: false,
    });

    expect(result.records.map(({ scenarioId }) => scenarioId)).toEqual([1, 99]);
    expect(await Bun.file(path).text()).toContain("Unseen cached");
  });
});
