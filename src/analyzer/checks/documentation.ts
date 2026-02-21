import type { ClassifiedModule, Issue, Note } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

const HEBREW_REGEX = /[\u0590-\u05FF]/;
const MIN_DOC_LENGTH = 15;

/**
 * Documentation is REQUIRED for modules where purpose isn't self-evident:
 * - http: modules (generic endpoints — what API? what data?)
 * - Webhook triggers (what external system sends data here?)
 * - Modules with opaque/complex behavior that needs explanation
 *
 * Documentation is RECOMMENDED (optional) for:
 * - Standard API modules (powerlink, monday, gmail, etc.)
 *
 * NEVER required for excluded/utility modules.
 */
function requiresDocumentation(moduleType: string, classification: string): boolean {
  if (moduleType.startsWith("http:")) return true;
  if (classification === "trigger" && moduleType.startsWith("gateway:")) return true;
  return false;
}

function stripHtml(content: string): string {
  return content.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function isValidDocumentation(content: string): boolean {
  const stripped = stripHtml(content);
  if (stripped.length <= MIN_DOC_LENGTH) return false;
  if (HEBREW_REGEX.test(stripped)) return false;
  return true;
}

export function checkDocumentation(classified: ClassifiedModule[], notes: Note[]): Issue[] {
  const issues: Issue[] = [];

  if (notes.length === 0) {
    issues.push({
      moduleId: null,
      moduleType: null,
      category: "documentation",
      severity: "warning",
      message: "לתרחיש אין הערות תיעוד כלל. יש להוסיף הערות (Notes) המתארות את מטרת התרחיש, לוגיקה עסקית, ותלויות חיצוניות",
      autoFixable: false,
    });
  }

  const noteContentByModuleId = new Map<number, string>();
  for (const note of notes) {
    for (const moduleId of note.moduleIds) {
      noteContentByModuleId.set(moduleId, note.content);
    }
  }

  for (const { module, classification } of classified) {
    if (classification === "excluded") continue;

    const content = noteContentByModuleId.get(module.id);
    const isRequired = requiresDocumentation(module.module, classification);

    if (isRequired && (!content || !isValidDocumentation(content))) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "documentation",
        severity: "info",
        message: `מודול ${module.id} - ${label} - חסר תיעוד באנגלית (מעל 15 תווים). יש להוסיף הערה מפורטת המסבירה את תפקיד המודול`,
        autoFixable: true,
      });
    }
  }

  return issues;
}
