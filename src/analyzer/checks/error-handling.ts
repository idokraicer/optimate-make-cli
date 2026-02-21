import type { ClassifiedModule, ErrorHandler, Issue } from "../../make-api/types";
import { hasErrorHandler, translateModuleType } from "../../utils/module-helpers";

export function describeErrorHandler(handlers: ErrorHandler[]): string {
  return handlers.map(describeOneHandler).join(" → ");
}

function describeOneHandler(handler: ErrorHandler): string {
  const type = handler.module;

  if (type === "builtin:Break") {
    const mapper = handler.mapper;
    if (mapper?.retry) {
      const count = mapper.count ?? "?";
      const interval = mapper.interval ? formatDuration(mapper.interval) : "?";
      return `Break (retry=${count}, interval=${interval})`;
    }
    return "Break";
  }

  if (type === "builtin:Resume") return "Resume";
  if (type === "builtin:Ignore") return "Ignore";
  if (type === "builtin:Commit") return "Commit";
  if (type === "builtin:Rollback") return "Rollback";

  if (type === "builtin:BasicRouter") {
    const routes = handler.routes ?? [];
    const parts: string[] = [];
    for (const route of routes) {
      if (Array.isArray(route.flow) && route.flow.length > 0) {
        const inner = route.flow.map(describeOneHandler).join(" → ");
        parts.push(`[${inner}]`);
      }
    }
    return parts.length > 0 ? `Router ${parts.join(", ")}` : "Router";
  }

  if (type === "util:FunctionSleep") {
    const seconds = handler.mapper?.duration ?? handler.parameters?.duration;
    return seconds ? `Sleep(${formatDuration(seconds)})` : "Sleep";
  }

  // Fallback: custom name or translated module type
  const customName = handler.metadata?.designer?.name?.trim();
  if (customName) return customName;
  return translateModuleType(type);
}

function formatDuration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function checkErrorHandling(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification !== "api") continue;

    const label = translateModuleType(module.module);

    if (!hasErrorHandler(module)) {
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "error-handling",
        severity: "warning",
        message: `מודול ${module.id} - ${label} - חסר טיפול בשגיאות. יש להוסיף error handler מסוג Break (או Resume/Ignore לפי הקונטקסט)`,
        autoFixable: true,
      });
    } else {
      const description = describeErrorHandler(module.onerror!);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "error-handling",
        severity: "info",
        message: `מודול ${module.id} - ${label} - טיפול בשגיאות: ${description}`,
        autoFixable: false,
      });
    }
  }

  return issues;
}
