import type { Module } from "../../make-api/types";

export function setModuleName(module: Module, name: string): Module {
  return {
    ...module,
    metadata: {
      ...module.metadata,
      designer: {
        ...module.metadata?.designer,
        name,
      },
    },
  };
}
