import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteOwnershipStore, type OwnedScenarioRecord } from "./ownership-store";

function record(overrides: Partial<OwnedScenarioRecord> = {}): OwnedScenarioRecord {
  return {
    scenarioId: 7,
    operationId: "operation-7",
    teamId: 21,
    organizationId: 9,
    baseUrl: "https://eu1.make.com",
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
    lastVerifiedFingerprint: "fingerprint-7",
    remoteVerifiedAt: "2026-07-23T10:00:00.000Z",
    lifecycleState: "created",
    executionId: null,
    ...overrides,
  };
}

describe("SqliteOwnershipStore", () => {
  test("reserves an operation before creation and atomically assigns its scenario ID", () => {
    const store = new SqliteOwnershipStore({ dbPath: ":memory:" });
    store.beginProbe({
      operationId: "probe-operation",
      teamId: 21,
      organizationId: 9,
      baseUrl: "https://eu1.make.com",
      createdAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:00:00.000Z",
      lastVerifiedFingerprint: "requested",
      remoteVerifiedAt: null,
      lifecycleState: "creating",
      executionId: null,
    });
    expect(store.listPending()).toEqual([]);
    expect(store.listProbeIntents()).toMatchObject([{
      operationId: "probe-operation",
      lifecycleState: "creating",
    }]);

    store.assignProbeScenario("https://eu1.make.com", "probe-operation", 44);
    expect(store.get("https://eu1.make.com", 44)).toMatchObject({
      scenarioId: 44,
      operationId: "probe-operation",
      lifecycleState: "created",
      lastVerifiedFingerprint: "requested",
    });
    expect(store.listPending()).toMatchObject([{
      scenarioId: 44,
      operationId: "probe-operation",
      lifecycleState: "created",
    }]);
    expect(store.listProbeIntents()).toEqual([]);
    store.update("https://eu1.make.com", 44, { lifecycleState: "inactive" });
    expect(store.get("https://eu1.make.com", 44)?.lifecycleState).toBe("inactive");
  });

  test("can discard a pre-create operation intent after a definitive create failure", () => {
    const store = new SqliteOwnershipStore({ dbPath: ":memory:" });
    store.beginProbe({
      operationId: "probe-operation",
      teamId: 21,
      organizationId: 9,
      baseUrl: "https://eu1.make.com",
      createdAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:00:00.000Z",
      lastVerifiedFingerprint: "requested",
      remoteVerifiedAt: null,
      lifecycleState: "creating",
      executionId: null,
    });
    store.discardProbeIntent("https://eu1.make.com", "probe-operation");
    expect(store.listPending()).toEqual([]);
    expect(() => store.assignProbeScenario(
      "https://eu1.make.com",
      "probe-operation",
      44,
    )).toThrow("intent");
  });

  test("uses WAL and persists lifecycle updates under a unique base URL and scenario ID", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ownership-")), "state.sqlite");
    const store = new SqliteOwnershipStore({ dbPath });
    store.put(record());
    store.put(record({ baseUrl: "https://us1.make.com", operationId: "other-zone" }));
    store.update("https://eu1.make.com/", 7, {
      lifecycleState: "running",
      executionId: "execution-1",
    });

    expect(store.get("https://eu1.make.com", 7)).toMatchObject({
      operationId: "operation-7",
      lifecycleState: "running",
      executionId: "execution-1",
    });
    expect(store.get("https://us1.make.com", 7)?.operationId).toBe("other-zone");
    expect(new Database(dbPath).query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(() => store.put(record({ operationId: "duplicate" }))).toThrow();
  });

  test("orders pending cleanup oldest first and excludes deleted records", () => {
    const store = new SqliteOwnershipStore({ dbPath: ":memory:" });
    store.put(record({ scenarioId: 8, createdAt: "2026-07-23T11:00:00.000Z" }));
    store.put(record({ scenarioId: 7, createdAt: "2026-07-23T10:00:00.000Z" }));
    expect(store.listPending().map((item) => item.scenarioId)).toEqual([7, 8]);

    store.markDeleted("https://eu1.make.com", 7);
    expect(store.get("https://eu1.make.com", 7)?.lifecycleState).toBe("deleted");
    expect(store.listPending().map((item) => item.scenarioId)).toEqual([8]);
  });

  test("migrates legacy ownership records as remotely unverified", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ownership-legacy-")), "state.sqlite");
    const db = new Database(dbPath, { create: true });
    db.exec(`
      CREATE TABLE owned_scenarios (
        base_url TEXT NOT NULL, scenario_id INTEGER NOT NULL, operation_id TEXT NOT NULL,
        team_id INTEGER NOT NULL, organization_id INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, last_verified_fingerprint TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL, execution_id TEXT,
        PRIMARY KEY (base_url, scenario_id)
      );
      INSERT INTO owned_scenarios VALUES (
        'https://eu1.make.com', 7, 'legacy', 21, 9,
        '2026-07-23T10:00:00.000Z', '2026-07-23T10:00:00.000Z',
        'local-only', 'verified', NULL
      );
    `);
    db.close();

    const store = new SqliteOwnershipStore({ dbPath });
    expect(store.get("https://eu1.make.com", 7)?.remoteVerifiedAt).toBeNull();
  });
});
