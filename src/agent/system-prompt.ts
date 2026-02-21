import type { Blueprint } from "../make-api/types";
import type { AnalysisResult } from "../analyzer/index";
import { walkModules } from "../utils/blueprint-traversal";
import { getModuleCustomName, hasErrorHandler } from "../utils/module-helpers";

export function buildSystemPrompt(
  blueprint: Blueprint,
  analysis: AnalysisResult,
  nextId: number
): string {
  const sections: string[] = [];

  sections.push(`You are a Make.com scenario editor agent. You help users build, modify, and fix automation scenarios by editing their blueprint JSON.

You have tools to read the blueprint, make structured edits, run analysis, validate changes, and push to Make.com.

IMPORTANT RULES:
- Respond in the same language the user writes in.
- Always explain what you plan to change before making edits.
- Always call validate_changes before push_blueprint.
- Always ask for user confirmation before calling push_blueprint.
- New modules must use IDs starting from nextId: ${nextId}. Never reuse existing IDs.
- The idSequence field is server-managed — do not set it.
- Use your knowledge of Make.com module structures. For unfamiliar modules, infer from existing ones in the blueprint.`);

  const modules = walkModules(blueprint.flow);
  const moduleLines = modules.map((m) => {
    const name = getModuleCustomName(m.module);
    const errHandler = hasErrorHandler(m.module) ? "\u2713" : "\u2717";
    const nameStr = name ? ` "${name}"` : "";
    const indent = "  ".repeat(m.depth);
    return `${indent}#${m.module.id}: ${m.module.module}${nameStr} [err: ${errHandler}]`;
  });

  sections.push(`SCENARIO: "${blueprint.name}"
MODULES (${modules.length}):
${moduleLines.join("\n")}`);

  if (analysis.issues.length > 0) {
    const issueLines = analysis.issues.map((i) => {
      const modRef = i.moduleId ? `#${i.moduleId}` : "scenario";
      return `  [${i.severity}] ${modRef}: ${i.message}`;
    });
    sections.push(`CURRENT ISSUES (${analysis.issues.length}):
${issueLines.join("\n")}`);
  } else {
    sections.push("CURRENT ISSUES: None \u2014 scenario looks good!");
  }

  sections.push(`CHECKLIST:
  Error Handling: ${analysis.checklist.hasErrorHandling ? "\u2713" : "\u2717"}
  Module Names: ${analysis.checklist.hasProperModuleNames ? "\u2713" : "\u2717"}
  Documentation: ${analysis.checklist.hasNotes ? "\u2713" : "\u2717"}`);

  return sections.join("\n\n");
}
