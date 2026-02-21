import type { ClassifiedModule, Issue } from "../../make-api/types";

const OPTIMATE_ORG_ID = "491016";

export function checkConnectionValidation(
  _classified: ClassifiedModule[],
  organizationId?: string
): Issue[] {
  if (!organizationId || organizationId === OPTIMATE_ORG_ID) return [];
  return [];
}
