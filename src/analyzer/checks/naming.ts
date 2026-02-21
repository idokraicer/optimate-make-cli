import type { ClassifiedModule, Issue } from "../../make-api/types";
import { hasCustomName, translateModuleType } from "../../utils/module-helpers";

export function checkNaming(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification === "excluded") continue;

    if (!hasCustomName(module)) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "naming",
        severity: "info",
        message: `מודול ${module.id} - ${label} - משתמש בשם ברירת מחדל. יש להגדיר שם מותאם אישית המתאר את תפקיד המודול`,
        autoFixable: true,
      });
    }
  }

  return issues;
}
