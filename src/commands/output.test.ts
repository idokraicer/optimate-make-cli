import { describe, expect, test } from "bun:test";
import {
  exitCodeFor,
  failureEnvelope,
  successEnvelope,
} from "./output";
import type { ClassifiedApiError } from "../make-api/api-error";

const capabilityError: ClassifiedApiError = {
  code: "SCOPE_MISSING",
  message: "The configured Make token lacks scenarios:run.",
  httpStatus: 403,
  providerCode: "SC403",
  retryable: false,
};

describe("command output envelopes", () => {
  test("creates stable success envelopes with provenance metadata", () => {
    const meta = {
      cliVersion: "0.2.0",
      source: "remote",
      verifiedAt: "2026-07-23T00:00:00.000Z",
      scenarioId: 123,
    };

    expect(successEnvelope("inspect", { modules: 3 }, meta)).toEqual({
      ok: true,
      command: "inspect",
      data: { modules: 3 },
      meta,
    });
  });

  test("creates stable failure envelopes without leaking transport details", () => {
    expect(failureEnvelope("run", capabilityError)).toEqual({
      ok: false,
      command: "run",
      error: capabilityError,
    });
  });

  test.each([
    ["AUTH_INVALID", 2],
    ["SCOPE_MISSING", 2],
    ["PLAN_RESTRICTED", 2],
    ["NOT_SUPPORTED", 2],
    ["RATE_LIMITED", 3],
    ["TRANSIENT", 3],
    ["NOT_FOUND", 1],
    ["INVALID_DATA", 1],
    ["UNKNOWN_API_ERROR", 1],
  ] as const)("maps %s to exit code %i", (code, exitCode) => {
    expect(exitCodeFor({ ...capabilityError, code })).toBe(exitCode);
  });
});
