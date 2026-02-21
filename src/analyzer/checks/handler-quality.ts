import type { ClassifiedModule, Issue } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

export function checkHandlerQuality(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification !== "api") continue;
    if (!Array.isArray(module.onerror) || module.onerror.length === 0) continue;

    const handlers = module.onerror;

    if (module.module.startsWith("http:")) {
      const hasBreak = handlers.some((h: any) => h.module === "builtin:Break");
      const hasWebhookRespond = handlers.some((h: any) => h.module === "gateway:WebhookRespond");
      if (hasBreak && !hasWebhookRespond) {
        const label = translateModuleType(module.module);
        issues.push({
          moduleId: module.id,
          moduleType: module.module,
          category: "handler-quality",
          severity: "info",
          message: `מודול ${module.id} - ${label} - משתמש ב-Break שעשוי להיות לא מתאים לשגיאות 400. שקול Resume עם נתונים ידניים או Ignore אם השגיאה צפויה`,
          autoFixable: false,
        });
      }
    }

    const hasResume = handlers.some((h: any) => h.module === "builtin:Resume");
    const hasSleep = handlers.some((h: any) => h.module === "tools:Sleep");
    if (hasResume && !hasSleep) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "handler-quality",
        severity: "info",
        message: `מודול ${module.id} - ${label} - משתמש ב-Resume ללא המתנה. במקרה של שגיאת 429 (Rate Limit) יש להוסיף Sleep של 45-60 שניות`,
        autoFixable: false,
      });
    }
  }

  return issues;
}
