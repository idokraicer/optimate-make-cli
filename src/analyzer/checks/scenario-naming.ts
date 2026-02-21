import type { Blueprint, Issue } from "../../make-api/types";

const ACTION_VERBS = [
  "sync", "create", "update", "send", "notify", "delete", "fetch", "get",
  "process", "import", "export", "migrate", "transform", "validate", "check",
  "receiving", "order", "new", "handle", "route", "forward",
];

const BUSINESS_OBJECTS = [
  "lead", "order", "invoice", "customer", "contact", "task", "project",
  "message", "email", "payment", "subscription", "ticket", "deal",
  "function", "form", "webhook", "event", "notification",
];

export function scoreScenarioName(name: string): number {
  let score = 0;
  const lower = name.toLowerCase();

  if (name.length >= 20) score++;

  const triggerPatterns = ["webhook", "from", "new ", "when", "on ", "receiving", "trigger"];
  if (triggerPatterns.some((p) => lower.includes(p))) score++;

  const targetPatterns = ["->", "to ", "into ", "in ", "→"];
  if (targetPatterns.some((p) => lower.includes(p))) score++;

  if (ACTION_VERBS.some((v) => lower.includes(v))) score++;

  if (BUSINESS_OBJECTS.some((o) => lower.includes(o))) score++;

  const wordCount = name.split(/[\s\-_:]+/).filter(Boolean).length;
  if (wordCount >= 4) score++;

  return score;
}

export function checkScenarioNaming(blueprint: Blueprint): Issue[] {
  const score = scoreScenarioName(blueprint.name);

  if (score >= 4) return [];

  return [
    {
      moduleId: null,
      moduleType: null,
      category: "scenario-naming",
      severity: "info",
      message: `שם הסנריו '${blueprint.name}' אינו תיאורי מספיק. שם טוב צריך להסביר: מה מפעיל את התרחיש, איזה מידע עובר, ולאן. מומלץ פורמט: '[Trigger/Source]: [Action] [Data] -> [Target] - [Context]'`,
      autoFixable: true,
    },
  ];
}
