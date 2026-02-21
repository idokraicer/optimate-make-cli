import type { Blueprint, ClassifiedModule } from "../make-api/types";
import { isExcludedModule } from "../utils/module-helpers";
import { walkModules } from "../utils/blueprint-traversal";

export function classifyModules(blueprint: Blueprint): ClassifiedModule[] {
  const walked = walkModules(blueprint.flow);
  const triggerId = blueprint.flow.length > 0 ? blueprint.flow[0].id : null;

  return walked.map(({ module, path }) => {
    let classification: ClassifiedModule["classification"];

    if (module.id === triggerId) {
      classification = "trigger";
    } else if (isExcludedModule(module.module)) {
      classification = "excluded";
    } else {
      classification = "api";
    }

    return { module, classification, path };
  });
}
