import type { ClassifiedModule, Issue } from "../../make-api/types";

const TEMPLATE_VAR_IN_BODY = /\{\{\d+\.\w+\}\}/;

export function checkJsonSafety(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification === "excluded") continue;
    if (!module.module.startsWith("http:")) continue;

    const body = module.mapper?.body || module.mapper?.jsonStringBodyContent;
    if (typeof body !== "string") continue;
    if (!TEMPLATE_VAR_IN_BODY.test(body)) continue;

    if (/^\{\{\d+\.[^}]+\}\}$/.test(body.trim())) continue;

    issues.push({
      moduleId: module.id,
      moduleType: module.module,
      category: "json-safety",
      severity: "warning",
      message: `מודול ${module.id} - HTTP - נתונים עם תווים מיוחדים (עברית, גרשיים) עלולים לשבור את ה-JSON. יש להשתמש במודול JSON או Code ליצירת ה-body`,
      autoFixable: false,
    });
  }

  return issues;
}
