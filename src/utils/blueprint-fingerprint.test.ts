import { describe, expect, test } from "bun:test";
import type { Blueprint } from "../make-api/types";
import { fingerprintBlueprint } from "./blueprint-fingerprint";

describe("fingerprintBlueprint", () => {
  test("is unchanged when object keys are reordered", async () => {
    const ordered = {
      name: "Example",
      flow: [{ id: 1, module: "http:ActionSendData", mapper: { alpha: "a", beta: "b" } }],
    } as Blueprint;
    const reordered = {
      flow: [{ mapper: { beta: "b", alpha: "a" }, module: "http:ActionSendData", id: 1 }],
      name: "Example",
    } as Blueprint;

    expect(await fingerprintBlueprint(reordered)).toBe(await fingerprintBlueprint(ordered));
  });

  test("changes when a scalar value changes", async () => {
    const before = {
      name: "Example",
      flow: [{ id: 1, module: "http:ActionSendData", mapper: { boardId: 10 } }],
    } as Blueprint;
    const after = structuredClone(before);
    after.flow[0].mapper.boardId = 11;

    expect(await fingerprintBlueprint(after)).not.toBe(await fingerprintBlueprint(before));
  });
});
