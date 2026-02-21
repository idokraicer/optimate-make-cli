import type { ClassifiedModule, Issue } from "../../make-api/types";
import { hasErrorHandler, translateModuleType } from "../../utils/module-helpers";

export function checkErrorHandling(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification !== "api") continue;

    if (!hasErrorHandler(module)) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "error-handling",
        severity: "warning",
        message: `מודול ${module.id} - ${label} - חסר טיפול בשגיאות. יש להוסיף error handler מסוג Break (או Resume/Ignore לפי הקונטקסט)`,
        autoFixable: true,
      });
    }
  }

  return issues;
}
