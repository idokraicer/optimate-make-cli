import type { ClassifiedModule, Issue } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

const MIN_ITEMS_THRESHOLD = 10;

function findLongLists(obj: unknown, path = ""): { path: string; count: number; sample: string }[] {
  const findings: { path: string; count: number; sample: string }[] = [];
  if (typeof obj === "string") {
    const splitMatch = obj.match(/split\("([^"]{50,})"\s*;\s*"[,;|]"\)/);
    if (splitMatch) {
      const items = splitMatch[1].split(/[,;|]/);
      if (items.length >= MIN_ITEMS_THRESHOLD) {
        findings.push({ path, count: items.length, sample: items.slice(0, 3).join(",") + "..." });
      }
    }
    const commaItems = obj.split(",");
    if (commaItems.length >= MIN_ITEMS_THRESHOLD && obj.length > 100 && !obj.includes("{{")) {
      findings.push({ path, count: commaItems.length, sample: commaItems.slice(0, 3).join(",") + "..." });
    }
  } else if (Array.isArray(obj)) {
    obj.forEach((item, i) => findings.push(...findLongLists(item, `${path}[${i}]`)));
  } else if (obj && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      findings.push(...findLongLists(value, `${path}.${key}`));
    }
  }
  return findings;
}

export function checkHardcodedData(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module } of classified) {
    const sources = [module.filter, module.mapper].filter(Boolean);
    for (const source of sources) {
      const findings = findLongLists(source);
      for (const finding of findings) {
        const label = translateModuleType(module.module);
        issues.push({
          moduleId: module.id,
          moduleType: module.module,
          category: "hardcoded-data",
          severity: "warning",
          message: `מודול ${module.id} - ${label} - זוהה מידע קבוע (Hardcoded) בכמות גדולה: ${finding.count} ערכים (${finding.sample}). מומלץ לשלוף את המידע באופן דינמי מ-Fireberry/Monday/מקור נתונים אחר`,
          autoFixable: false,
        });
      }
    }
  }

  return issues;
}
