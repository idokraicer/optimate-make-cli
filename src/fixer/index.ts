import type { Blueprint, Issue, Module } from "../make-api/types";
import { addErrorHandler } from "./fixes/add-error-handler";
import { addExistenceFilter } from "./fixes/add-existence-filter";
import { setModuleName } from "./fixes/set-module-name";
import { renameScenario } from "./fixes/rename-scenario";
import { findUnsafeWebhookVars } from "../analyzer/checks/data-validation";
import { generateModuleName, generateScenarioName } from "./ai-content";
import { getMaxModuleId } from "../utils/module-helpers";
import { walkModules } from "../utils/blueprint-traversal";

export interface FixChange {
  type: "error-handler" | "naming" | "scenario-naming" | "data-validation";
  moduleId: number | null;
  description: string;
}

export interface FixResult {
  fixed: Blueprint;
  changes: FixChange[];
}

export interface FixOptions {
  skipAi?: boolean;
  only?: string[];
}

export async function applyFixes(
  blueprint: Blueprint,
  issues: Issue[],
  options: FixOptions = {}
): Promise<FixResult> {
  const { skipAi = false, only } = options;
  const changes: FixChange[] = [];

  let fixed: Blueprint = JSON.parse(JSON.stringify(blueprint));

  const shouldApply = (category: string) => !only || only.includes(category);

  let nextId = getMaxModuleId(fixed.flow) + 1;

  // --- Error Handler Fixes ---
  if (shouldApply("error-handling")) {
    const errorIssues = issues.filter(
      (i) => i.category === "error-handling" && i.autoFixable
    );
    for (const issue of errorIssues) {
      fixed = applyToModule(fixed, issue.moduleId!, (mod) => {
        const result = addErrorHandler(mod, nextId);
        nextId++;
        changes.push({
          type: "error-handler",
          moduleId: issue.moduleId,
          description: `Added Break error handler to module ${issue.moduleId}`,
        });
        return result;
      });
    }
  }

  // --- Data Validation Fixes ---
  if (shouldApply("data-validation")) {
    const dataIssues = issues.filter(
      (i) => i.category === "data-validation" && i.autoFixable
    );
    for (const issue of dataIssues) {
      fixed = applyToModule(fixed, issue.moduleId!, (mod) => {
        const unsafeVars = findUnsafeWebhookVars(mod.mapper);
        if (unsafeVars.length === 0) return mod;
        const varList = unsafeVars.map((v) => `{{${v}}}`).join(", ");
        changes.push({
          type: "data-validation",
          moduleId: issue.moduleId,
          description: `Added existence filter for ${varList} on module ${issue.moduleId}`,
        });
        return addExistenceFilter(mod, unsafeVars);
      });
    }
  }

  // --- Naming Fixes ---
  if (shouldApply("naming")) {
    const namingIssues = issues.filter(
      (i) => i.category === "naming" && i.autoFixable
    );
    for (const issue of namingIssues) {
      let name: string;
      if (skipAi) {
        name = `${issue.moduleType} (auto-named)`;
      } else {
        const walked = walkModules(fixed.flow);
        const mod = walked.find((w) => w.module.id === issue.moduleId);
        name = await generateModuleName(
          issue.moduleType!,
          mod?.module.mapper
        );
      }
      fixed = applyToModule(fixed, issue.moduleId!, (mod) => {
        changes.push({
          type: "naming",
          moduleId: issue.moduleId,
          description: `Renamed module ${issue.moduleId} to "${name}"`,
        });
        return setModuleName(mod, name);
      });
    }
  }

  // --- Scenario Naming Fix ---
  if (shouldApply("scenario-naming")) {
    const namingIssue = issues.find(
      (i) => i.category === "scenario-naming" && i.autoFixable
    );
    if (namingIssue) {
      let newName: string;
      if (skipAi) {
        newName = `${fixed.name} (auto-renamed)`;
      } else {
        const moduleTypes = walkModules(fixed.flow).map((w) => w.module.module);
        newName = await generateScenarioName(fixed.name, moduleTypes);
      }
      fixed = renameScenario(fixed, newName);
      changes.push({
        type: "scenario-naming",
        moduleId: null,
        description: `Renamed scenario from "${blueprint.name}" to "${newName}"`,
      });
    }
  }

  return { fixed, changes };
}

function applyToModule(
  blueprint: Blueprint,
  moduleId: number,
  transform: (mod: Module) => Module
): Blueprint {
  return {
    ...blueprint,
    flow: applyToModuleInFlow(blueprint.flow, moduleId, transform),
  };
}

function applyToModuleInFlow(
  flow: Module[],
  moduleId: number,
  transform: (mod: Module) => Module
): Module[] {
  return flow.map((mod) => {
    if (mod.id === moduleId) {
      return transform(mod);
    }
    if (Array.isArray(mod.routes)) {
      return {
        ...mod,
        routes: mod.routes.map((route: any) => ({
          ...route,
          flow: route.flow
            ? applyToModuleInFlow(route.flow, moduleId, transform)
            : route.flow,
        })),
      };
    }
    return mod;
  });
}
