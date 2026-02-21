import type { ClassifiedModule, Issue, Note } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

const REQUIRES_DOCUMENTATION_PREFIXES = ["http:", "manychat:"];
const HEBREW_REGEX = /[\u0590-\u05FF]/;
const MIN_DOC_LENGTH = 15;

function requiresDocumentation(moduleType: string, _classification: string): boolean {
  if (REQUIRES_DOCUMENTATION_PREFIXES.some((p) => moduleType.startsWith(p))) return true;
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

  const noteContentByModuleId = new Map<number, string>();
  for (const note of notes) {
    for (const moduleId of note.moduleIds) {
      noteContentByModuleId.set(moduleId, note.content);
    }
  }

  for (const { module, classification } of classified) {
    if (!requiresDocumentation(module.module, classification)) continue;

    const content = noteContentByModuleId.get(module.id);
    if (!content || !isValidDocumentation(content)) {
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
