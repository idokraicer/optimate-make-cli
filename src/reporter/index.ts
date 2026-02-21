import type { Issue } from "../make-api/types";
import type { FixChange } from "../fixer/index";

interface Checklist {
  hasErrorHandling: boolean;
  hasProperModuleNames: boolean;
  hasNotes: boolean;
}

export function formatReport(
  changes: FixChange[],
  remainingIssues: Issue[],
  checklist: Checklist
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

  if (changes.length === 0 && remainingIssues.length === 0) {
    lines.push("No issues found — great work! ✓");
  }

  return lines.join("\n");
}

export function formatJson(
  changes: FixChange[],
  remainingIssues: Issue[],
  checklist: Checklist
): string {
  return JSON.stringify({ changes, remainingIssues, checklist }, null, 2);
}
