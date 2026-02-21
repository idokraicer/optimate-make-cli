import { describe, expect, test } from "bun:test";
import { MakeApiClient } from "./client";
import { MakeAppSchema, AppModuleSchema } from "./types";

describe("MakeApiClient", () => {
  test("constructs correct blueprint URL", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
    });
    expect(client.getBlueprintUrl(12345)).toBe(
      "https://eu1.make.com/api/v2/scenarios/12345/blueprint"
    );
  });

  test("constructs correct scenario URL for patching", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
    });
    expect(client.getScenarioUrl(12345)).toBe(
      "https://eu1.make.com/api/v2/scenarios/12345"
    );
  });

  test("strips trailing slash from base URL", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com/",
    });
    expect(client.getBlueprintUrl(1)).toBe(
      "https://eu1.make.com/api/v2/scenarios/1/blueprint"
    );
  });

  test("createNote method exists and is callable", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
    });
    expect(typeof client.createNote).toBe("function");
  });

  test("fetchApps method exists and is callable", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
    });
    expect(typeof client.fetchApps).toBe("function");
  });

  test("fetchAppModules method exists and is callable", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com",
    });
    expect(typeof client.fetchAppModules).toBe("function");
  });
});

describe("MakeAppSchema", () => {
  test("parses a full app object", () => {
    const app = MakeAppSchema.parse({
      name: "google-sheets",
      label: "Google Sheets",
      version: 2,
      theme: "#0f9d58",
      keywords: "spreadsheet,sheets",
      categories: ["productivity"],
      isPrivate: false,
      premiumTier: 0,
    });

    expect(app.name).toBe("google-sheets");
    expect(app.label).toBe("Google Sheets");
    expect(app.version).toBe(2);
    expect(app.keywords).toBe("spreadsheet,sheets");
    expect(app.categories).toEqual(["productivity"]);
  });

  test("handles null fields gracefully", () => {
    const app = MakeAppSchema.parse({
      name: "test-app",
      label: "Test",
      version: 1,
      theme: null,
      keywords: null,
      categories: null,
      isPrivate: null,
      premiumTier: null,
    });

    expect(app.theme).toBe("");
    expect(app.keywords).toBe("");
    expect(app.categories).toEqual([]);
    expect(app.isPrivate).toBe(false);
    expect(app.premiumTier).toBe(0);
  });

  test("handles missing optional fields", () => {
    const app = MakeAppSchema.parse({
      name: "minimal",
      label: "Minimal App",
      version: 1,
    });

    expect(app.keywords).toBe("");
    expect(app.categories).toEqual([]);
  });

  test("preserves extra fields via catchall", () => {
    const app = MakeAppSchema.parse({
      name: "test",
      label: "Test",
      version: 1,
      brand: { logo: "url" },
      coming_soon: false,
    });

    expect((app as any).brand).toEqual({ logo: "url" });
  });
});

describe("AppModuleSchema", () => {
  test("parses a full module object", () => {
    const mod = AppModuleSchema.parse({
      id: "addRow",
      name: "addRow",
      label: "Add a Row",
      type: "account:google",
      hook: false,
    });

    expect(mod.id).toBe("addRow");
    expect(mod.label).toBe("Add a Row");
    expect(mod.hook).toBe(false);
  });

  test("handles missing optional fields", () => {
    const mod = AppModuleSchema.parse({
      id: "test",
      name: "test",
      label: "Test Module",
    });

    expect(mod.type).toBe("");
    expect(mod.hook).toBe(false);
  });
});

describe("MakeApiClient.searchApps", () => {
  const client = new MakeApiClient({
    token: "test-token",
    baseUrl: "https://eu1.make.com",
  });

  const mockApps = [
    { name: "google-sheets", label: "Google Sheets", version: 2, theme: "", keywords: "spreadsheet,sheets", categories: [] as string[], isPrivate: false, premiumTier: 0 },
    { name: "google-drive", label: "Google Drive", version: 4, theme: "", keywords: "storage,files", categories: [] as string[], isPrivate: false, premiumTier: 0 },
    { name: "monday", label: "monday.com", version: 2, theme: "", keywords: "project,management", categories: [] as string[], isPrivate: false, premiumTier: 0 },
    { name: "powerlink", label: "Fireberry", version: 1, theme: "", keywords: "crm", categories: [] as string[], isPrivate: false, premiumTier: 0 },
    { name: "airtable", label: "Airtable", version: 2, theme: "", keywords: "database,spreadsheet", categories: [] as string[], isPrivate: false, premiumTier: 0 },
  ];

  test("filters by label", async () => {
    const results = await client.searchApps("google", mockApps);
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("google-sheets");
    expect(results[1].name).toBe("google-drive");
  });

  test("filters by name slug", async () => {
    const results = await client.searchApps("powerlink", mockApps);
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("Fireberry");
  });

  test("filters by keywords", async () => {
    const results = await client.searchApps("spreadsheet", mockApps);
    expect(results).toHaveLength(2);
    expect(results.map((a) => a.name)).toEqual(["google-sheets", "airtable"]);
  });

  test("is case-insensitive", async () => {
    const results = await client.searchApps("MONDAY", mockApps);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("monday");
  });

  test("returns empty for no matches", async () => {
    const results = await client.searchApps("nonexistent", mockApps);
    expect(results).toHaveLength(0);
  });

  test("matches partial strings", async () => {
    const results = await client.searchApps("crm", mockApps);
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("Fireberry");
  });
});
