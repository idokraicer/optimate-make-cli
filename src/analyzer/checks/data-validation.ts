import type { ClassifiedModule, Issue } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

const QUERY_ACTIONS = ["plquery", "query", "get", "search", "list", "read", "fetch", "find", "listboarditems", "getitem"];
const WEBHOOK_DATA_PATTERN = /\{\{[12]\.\w+\}\}/;
const SAFE_WRAPPERS = ["ifempty(", "if(", "emptystring("];

function usesWebhookDataUnsafely(mapper: any): boolean {
  if (!mapper || typeof mapper !== "object") return false;
  const str = JSON.stringify(mapper);
  if (!WEBHOOK_DATA_PATTERN.test(str)) return false;
  const refs = str.match(/\{\{[12]\.\w+\}\}/g) || [];
  for (const ref of refs) {
    const idx = str.indexOf(ref);
    const before = str.substring(Math.max(0, idx - 30), idx).toLowerCase();
    if (!SAFE_WRAPPERS.some((w) => before.includes(w))) {
      return true;
    }
  }
  return false;
}

export function checkDataValidation(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification !== "api") continue;

    const action = module.module.split(":")[1]?.toLowerCase() || "";
    if (!QUERY_ACTIONS.some((q) => action.includes(q))) continue;

    if (usesWebhookDataUnsafely(module.mapper)) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "data-validation",
        severity: "warning",
        message: `מודול ${module.id} - ${label} - משתמש בנתונים מוובהוק ללא בדיקת קיום. יש להוסיף פילטר לבדיקת קיום או להשתמש ב-ifempty()`,
        autoFixable: false,
      });
    }
  }

  return issues;
}
