import type { Blueprint, ClassifiedModule, DataFlowMap, Issue, Note } from "../make-api/types";
import { classifyModules } from "./module-classifier";
import { buildDataFlow } from "./checks/data-flow";
import { checkErrorHandling } from "./checks/error-handling";
import { checkNaming } from "./checks/naming";
import { checkScenarioNaming } from "./checks/scenario-naming";
import { checkSecurity } from "./checks/security";
import { checkHardcodedData } from "./checks/hardcoded";
import { checkDocumentation } from "./checks/documentation";
import { checkDataValidation } from "./checks/data-validation";
import { checkJsonSafety } from "./checks/json-safety";
import { checkHandlerQuality } from "./checks/handler-quality";
import { checkConnectionValidation } from "./checks/connection-validation";
import { checkRouteMerging } from "./checks/route-merging";

export interface AnalysisResult {
  classified: ClassifiedModule[];
  issues: Issue[];
  checklist: {
    hasErrorHandling: boolean;
    hasProperModuleNames: boolean;
    hasNotes: boolean;
  };
  dataFlow: DataFlowMap;
}

export function analyze(
  blueprint: Blueprint,
  notes: Note[],
  organizationId?: string
): AnalysisResult {
  const classified = classifyModules(blueprint);

  const issues: Issue[] = [
    ...checkErrorHandling(classified),
    ...checkNaming(classified),
    ...checkScenarioNaming(blueprint),
    ...checkSecurity(classified),
    ...checkHardcodedData(classified),
    ...checkDocumentation(classified, notes),
    ...checkDataValidation(classified),
    ...checkJsonSafety(classified),
    ...checkHandlerQuality(classified),
    ...checkConnectionValidation(classified, organizationId),
    ...checkRouteMerging(classified),
  ];

  const checklist = {
    hasErrorHandling: !issues.some((i) => i.category === "error-handling" && i.severity !== "info"),
    hasProperModuleNames: !issues.some((i) => i.category === "naming"),
    hasNotes: notes.length > 0,
  };

  const dataFlow = buildDataFlow(classified);

  return { classified, issues, checklist, dataFlow };
}
