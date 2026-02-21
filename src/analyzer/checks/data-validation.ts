import type { ClassifiedModule, Issue } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

const QUERY_ACTIONS = ["plquery", "query", "get", "search", "list", "read", "fetch", "find", "listboarditems", "getitem"];
const WEBHOOK_DATA_PATTERN = /\{\{[12]\.\w+\}\}/g;
const SAFE_WRAPPERS = ["ifempty(", "if(", "emptystring("];

export function findUnsafeWebhookVars(mapper: any): string[] {
  if (!mapper || typeof mapper !== "object") return [];
  const str = JSON.stringify(mapper);
  const refs = str.match(WEBHOOK_DATA_PATTERN) || [];
  const unsafe: string[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);

    const idx = str.indexOf(ref);
    const before = str.substring(Math.max(0, idx - 30), idx).toLowerCase();
    if (!SAFE_WRAPPERS.some((w) => before.includes(w))) {
      // Extract the inner variable reference (e.g. "1.phone" from "{{1.phone}}")
      unsafe.push(ref.slice(2, -2));
    }
  }
  return unsafe;
}

export function checkDataValidation(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification !== "api") continue;

    const action = module.module.split(":")[1]?.toLowerCase() || "";
    if (!QUERY_ACTIONS.some((q) => action.includes(q))) continue;

    const unsafeVars = findUnsafeWebhookVars(module.mapper);
    if (unsafeVars.length > 0) {
      const label = translateModuleType(module.module);
      const varList = unsafeVars.map((v) => `{{${v}}}`).join(", ");
      const filterHint = unsafeVars.map((v) => `"${v} exists"`).join(" + ");
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "data-validation",
        severity: "warning",
        message: `מודול ${module.id} - ${label} - משתמש בנתונים מוובהוק ללא בדיקת קיום: ${varList}. יש להוסיף פילטר ${filterHint}`,
        autoFixable: true,
      });
    }
  }

  return issues;
}
