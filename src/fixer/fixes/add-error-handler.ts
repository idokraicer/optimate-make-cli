import type { Module, ErrorHandler } from "../../make-api/types";
import { BREAK_DEFAULTS } from "../../make-api/types";

export function createBreakHandler(id: number): ErrorHandler {
  return {
    id,
    module: "builtin:Break",
    version: 1,
    parameters: {},
    mapper: { ...BREAK_DEFAULTS },
    metadata: {
      designer: { x: 0, y: 0 },
      parameters: [
        { name: "retry", type: "boolean", label: "Automatically retry" },
        { name: "count", type: "number", label: "Number of retries" },
        { name: "interval", type: "number", label: "Interval between retries" },
      ],
      expect: [
        { name: "retry", type: "boolean" },
        { name: "count", type: "integer" },
        { name: "interval", type: "integer" },
      ],
    },
  };
}

export function addErrorHandler(module: Module, nextId: number): Module {
  return {
    ...module,
    onerror: [createBreakHandler(nextId)],
  };
}
