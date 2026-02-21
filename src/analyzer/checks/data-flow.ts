import type { ClassifiedModule, VariableUsage, DataFlowEntry, DataFlowMap } from "../../make-api/types";

const VARIABLE_REF_PATTERN = /\{\{(\d+)\.([\w.]+)\}\}/g;

function extractStrings(obj: unknown, path = ""): Array<{ field: string; value: string }> {
  const results: Array<{ field: string; value: string }> = [];

  if (typeof obj === "string") {
    results.push({ field: path || "value", value: obj });
  } else if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      results.push(...extractStrings(item, `${path}[${i}]`));
    });
  } else if (obj && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = path ? `${path}.${key}` : key;
      results.push(...extractStrings(value, fieldPath));
    }
  }

  return results;
}

function extractReferences(module: ClassifiedModule["module"]): VariableUsage[] {
  const usages: VariableUsage[] = [];
  const sources: Array<{ data: unknown }> = [];

  if (module.mapper) sources.push({ data: module.mapper });
  if (module.filter) sources.push({ data: module.filter });

  for (const source of sources) {
    const strings = extractStrings(source.data);
    for (const { field, value } of strings) {
      const regex = new RegExp(VARIABLE_REF_PATTERN.source, "g");
      let match: RegExpExecArray | null;
      while ((match = regex.exec(value)) !== null) {
        const sourceModuleId = parseInt(match[1], 10);
        const varName = match[2];
        const topField = field.split(/[.\[]/)[0];
        usages.push({
          moduleId: module.id,
          field: topField,
          sourceModuleId,
          varName,
        });
      }
    }
  }

  return usages;
}

export function buildDataFlow(classified: ClassifiedModule[]): DataFlowMap {
  const allUsages: VariableUsage[] = [];

  for (const { module } of classified) {
    allUsages.push(...extractReferences(module));
  }

  const byVarName = new Map<string, VariableUsage[]>();

  for (const usage of allUsages) {
    const leafName = usage.varName.split(".").pop() || usage.varName;
    if (!byVarName.has(leafName)) {
      byVarName.set(leafName, []);
    }
    byVarName.get(leafName)!.push(usage);
  }

  const entries: DataFlowEntry[] = [];
  for (const [varName, usages] of byVarName) {
    usages.sort((a, b) => a.moduleId - b.moduleId);

    const seen = new Set<string>();
    const deduped = usages.filter((u) => {
      const key = `${u.moduleId}:${u.field}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    entries.push({ varName, usages: deduped });
  }

  entries.sort((a, b) => a.varName.localeCompare(b.varName));

  return { entries };
}

export function filterDataFlow(dataFlow: DataFlowMap, varNameFilter: string): DataFlowMap {
  const lower = varNameFilter.toLowerCase();
  return {
    entries: dataFlow.entries.filter(
      (e) => e.varName.toLowerCase().includes(lower)
    ),
  };
}
