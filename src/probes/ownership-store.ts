import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultRateDatabasePath } from "../make-api/rate-limiter";

export type ProbeLifecycleState =
  | "created"
  | "verified"
  | "active"
  | "running"
  | "terminal"
  | "inactive"
  | "cleanup_failed"
  | "deleted";

export interface OwnedScenarioRecord {
  scenarioId: number;
  operationId: string;
  teamId: number;
  organizationId: number;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  lastVerifiedFingerprint: string;
  remoteVerifiedAt: string | null;
  lifecycleState: ProbeLifecycleState;
  executionId: string | null;
}

export interface OwnershipStore {
  put(record: OwnedScenarioRecord): void;
  get(baseUrl: string, scenarioId: number): OwnedScenarioRecord | null;
  update(baseUrl: string, scenarioId: number, patch: Partial<OwnedScenarioRecord>): void;
  listPending(): OwnedScenarioRecord[];
  markDeleted(baseUrl: string, scenarioId: number): void;
}

type OwnershipStoreOptions = { dbPath?: string; now?: () => string };

export class SqliteOwnershipStore implements OwnershipStore {
  private readonly db: Database;
  private readonly now: () => string;

  constructor(options: OwnershipStoreOptions = {}) {
    const dbPath = options.dbPath ?? defaultRateDatabasePath();
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true, strict: true });
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owned_scenarios (
        base_url TEXT NOT NULL,
        scenario_id INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        team_id INTEGER NOT NULL,
        organization_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_verified_fingerprint TEXT NOT NULL,
        remote_verified_at TEXT,
        lifecycle_state TEXT NOT NULL,
        execution_id TEXT,
        PRIMARY KEY (base_url, scenario_id)
      )
    `);
    const columns = this.db.query("PRAGMA table_info(owned_scenarios)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "remote_verified_at")) {
      // Existing rows are deliberately NULL: legacy provenance cannot authorize deletion.
      this.db.exec("ALTER TABLE owned_scenarios ADD COLUMN remote_verified_at TEXT");
    }
  }

  put(record: OwnedScenarioRecord): void {
    const normalized = normalizeRecord(record);
    this.db.transaction(() => {
      this.db.query(`
        INSERT INTO owned_scenarios (
          base_url, scenario_id, operation_id, team_id, organization_id,
          created_at, updated_at, last_verified_fingerprint, remote_verified_at,
          lifecycle_state, execution_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.baseUrl, normalized.scenarioId, normalized.operationId,
        normalized.teamId, normalized.organizationId, normalized.createdAt,
        normalized.updatedAt, normalized.lastVerifiedFingerprint,
        normalized.remoteVerifiedAt,
        normalized.lifecycleState, normalized.executionId,
      );
    })();
  }

  get(baseUrl: string, scenarioId: number): OwnedScenarioRecord | null {
    const row = this.db.query(`
      SELECT * FROM owned_scenarios WHERE base_url = ? AND scenario_id = ?
    `).get(normalizeBaseUrl(baseUrl), scenarioId) as Record<string, unknown> | null;
    return row ? fromRow(row) : null;
  }

  update(baseUrl: string, scenarioId: number, patch: Partial<OwnedScenarioRecord>): void {
    const current = this.get(baseUrl, scenarioId);
    if (!current) return;
    const next = normalizeRecord({
      ...current,
      ...patch,
      baseUrl: current.baseUrl,
      scenarioId: current.scenarioId,
      updatedAt: this.now(),
    });
    this.db.transaction(() => {
      this.db.query(`
        UPDATE owned_scenarios SET operation_id = ?, team_id = ?, organization_id = ?,
          created_at = ?, updated_at = ?, last_verified_fingerprint = ?,
          remote_verified_at = ?, lifecycle_state = ?, execution_id = ?
        WHERE base_url = ? AND scenario_id = ?
      `).run(
        next.operationId, next.teamId, next.organizationId, next.createdAt, next.updatedAt,
        next.lastVerifiedFingerprint, next.remoteVerifiedAt,
        next.lifecycleState, next.executionId,
        next.baseUrl, next.scenarioId,
      );
    })();
  }

  listPending(): OwnedScenarioRecord[] {
    const rows = this.db.query(`
      SELECT * FROM owned_scenarios
      WHERE lifecycle_state != 'deleted'
      ORDER BY created_at ASC, scenario_id ASC
    `).all() as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  markDeleted(baseUrl: string, scenarioId: number): void {
    this.update(baseUrl, scenarioId, { lifecycleState: "deleted" });
  }
}

let defaultStore: SqliteOwnershipStore | undefined;

export function getDefaultOwnershipStore(): OwnershipStore {
  defaultStore ??= new SqliteOwnershipStore();
  return defaultStore;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeRecord(record: OwnedScenarioRecord): OwnedScenarioRecord {
  return { ...record, baseUrl: normalizeBaseUrl(record.baseUrl) };
}

function fromRow(row: Record<string, unknown>): OwnedScenarioRecord {
  return {
    scenarioId: Number(row.scenario_id),
    operationId: String(row.operation_id),
    teamId: Number(row.team_id),
    organizationId: Number(row.organization_id),
    baseUrl: String(row.base_url),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastVerifiedFingerprint: String(row.last_verified_fingerprint),
    remoteVerifiedAt: row.remote_verified_at === null || row.remote_verified_at === undefined
      ? null
      : String(row.remote_verified_at),
    lifecycleState: String(row.lifecycle_state) as ProbeLifecycleState,
    executionId: row.execution_id === null ? null : String(row.execution_id),
  };
}
