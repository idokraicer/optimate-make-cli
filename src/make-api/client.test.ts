import { describe, expect, test } from "bun:test";
import { MakeApiClient } from "./client";

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
});
