import type { Module } from "../../make-api/types";

export function addExistenceFilter(module: Module, unsafeVars: string[]): Module {
  if (unsafeVars.length === 0) return module;

  const existingFilter = module.filter;
  const existingConditions: any[][] =
    existingFilter?.conditions && Array.isArray(existingFilter.conditions)
      ? existingFilter.conditions
      : [];

  // Collect already-present existence checks to avoid duplicates
  const alreadyChecked = new Set<string>();
  for (const andGroup of existingConditions) {
    if (!Array.isArray(andGroup)) continue;
    for (const cond of andGroup) {
      if (cond?.o === "exist" && typeof cond?.a === "string") {
        alreadyChecked.add(cond.a);
      }
    }
  }

  // Build new existence conditions for vars that don't already have one
  const newConditions = unsafeVars
    .filter((v) => !alreadyChecked.has(`{{${v}}}`))
    .map((v) => ({ a: `{{${v}}}`, o: "exist" }));

  if (newConditions.length === 0) return module;

  let mergedConditions: any[][];
  if (existingConditions.length > 0) {
    // Prepend existence checks to the first AND group
    mergedConditions = [
      [...newConditions, ...existingConditions[0]],
      ...existingConditions.slice(1),
    ];
  } else {
    // Create a single AND group with all existence checks
    mergedConditions = [newConditions];
  }

  return {
    ...module,
    filter: {
      name: existingFilter?.name ?? "",
      conditions: mergedConditions,
    },
  };
}
