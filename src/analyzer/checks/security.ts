import type { ClassifiedModule, Issue } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

const SENSITIVE_KEYS = ["authorization", "api_key", "apikey", "token", "password", "secret", "api-key"];
const SAFE_PATTERNS = ["{{connection.", "{{variables.", "{{parameters."];

function containsHardcodedSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 8) return false;
  if (SAFE_PATTERNS.some((p) => value.includes(p))) return false;
  if (value.startsWith("{{") && value.endsWith("}}")) return false;
  return true;
}

function scanMapper(mapper: any): string[] {
  const findings: string[] = [];
  if (!mapper || typeof mapper !== "object") return findings;

  const scan = (obj: any, path: string) => {
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => scan(item, `${path}[${i}]`));
      return;
    }
    if (obj && typeof obj === "object") {
      // Handle {name, value} pair pattern (common in Make.com headers/params)
      if (typeof obj.name === "string" && "value" in obj) {
        const nameLower = obj.name.toLowerCase();
        if (SENSITIVE_KEYS.some((sk) => nameLower.includes(sk))) {
          if (containsHardcodedSecret(obj.value)) {
            findings.push(obj.name);
          }
        }
      }
      for (const [key, value] of Object.entries(obj)) {
        const keyLower = key.toLowerCase();
        if (SENSITIVE_KEYS.some((sk) => keyLower.includes(sk))) {
          if (containsHardcodedSecret(value)) {
            findings.push(key);
          }
        }
        scan(value, `${path}.${key}`);
      }
    }
  };

  scan(mapper, "mapper");
  return findings;
}

export function checkSecurity(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification === "excluded") continue;

    const findings = scanMapper(module.mapper);
    if (findings.length > 0) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "security",
        severity: "critical",
        message: `⚠️ קריטי - מודול ${module.id} - ${label} - מכיל API Key חשוף! יש ליצור Connection או לאחסן במשתנה מאובטח מיידית`,
        autoFixable: false,
      });
    }
  }

  return issues;
}
