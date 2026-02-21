import type { Blueprint } from "../../make-api/types";

export function renameScenario(blueprint: Blueprint, newName: string): Blueprint {
  return {
    ...blueprint,
    name: newName,
  };
}
