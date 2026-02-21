import type { DataFlowMap, Issue } from "../make-api/types";
import type { FixChange } from "../fixer/index";

interface Checklist {
  hasErrorHandling: boolean;
  hasProperModuleNames: boolean;
  hasNotes: boolean;
}

export function formatReport(
  changes: FixChange[],
  remainingIssues: Issue[],
  checklist: Checklist,
  dataFlow?: DataFlowMap
): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════╗");
  lines.push("║       Make Fixer — Report            ║");
  lines.push("╚══════════════════════════════════════╝");
  lines.push("");

  lines.push("Checklist:");
  lines.push(`  ${checklist.hasErrorHandling ? "✓" : "✗"} Error Handling`);
  lines.push(`  ${checklist.hasProperModuleNames ? "✓" : "✗"} Module Names`);
  lines.push(`  ${checklist.hasNotes ? "✓" : "✗"} Documentation`);
  lines.push("");

  if (changes.length > 0) {
    lines.push(`Auto-fixed (${changes.length}):`);
    for (const change of changes) {
      lines.push(`  ✓ ${change.description}`);
    }
    lines.push("");
  }

  const critical = remainingIssues.filter((i) => i.severity === "critical");
  const warnings = remainingIssues.filter((i) => i.severity === "warning");
  const info = remainingIssues.filter((i) => i.severity === "info");

  if (critical.length > 0) {
    lines.push(`Critical Issues (${critical.length}):`);
    for (const issue of critical) {
      lines.push(`  ⚠️  ${issue.message}`);
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push(`Warnings (${warnings.length}):`);
    for (const issue of warnings) {
      lines.push(`  ⚡ ${issue.message}`);
    }
    lines.push("");
  }

  if (info.length > 0) {
    lines.push(`Info (${info.length}):`);
    for (const issue of info) {
      lines.push(`  ℹ  ${issue.message}`);
    }
    lines.push("");
  }

  if (dataFlow && dataFlow.entries.length > 0) {
    lines.push("Data Flow:");
    for (const entry of dataFlow.entries) {
      const sourceIds = [...new Set(entry.usages.map((u) => u.sourceModuleId))];
      const chainParts: string[] = [];
      for (const srcId of sourceIds) {
        const consumers = entry.usages.filter((u) => u.sourceModuleId === srcId);
        const parts = [`#${srcId}:${entry.varName}`];
        for (const c of consumers) {
          parts.push(`#${c.moduleId}:${c.field}`);
        }
        chainParts.push(parts.join(" -> "));
      }
      lines.push(`  ${entry.varName}: ${chainParts.join(", ")}`);
    }
    lines.push("");
  }

  if (changes.length === 0 && remainingIssues.length === 0 && (!dataFlow || dataFlow.entries.length === 0)) {
    lines.push("No issues found — great work! ✓");
  }

  return lines.join("\n");
}

export function formatJson(
  changes: FixChange[],
  remainingIssues: Issue[],
  checklist: Checklist,
  dataFlow?: DataFlowMap
): string {
  return JSON.stringify(
    { changes, remainingIssues, checklist, ...(dataFlow ? { dataFlow: dataFlow.entries } : {}) },
    null,
    2
  );
}
