import type { Module } from "../make-api/types";
import { walkModules } from "./blueprint-traversal";

/** A single field entry from a module's metadata.interface array */
interface InterfaceField {
  name: string;
  type?: string;
  label?: string;
  [key: string]: unknown;
}

/**
 * Find a module by ID anywhere in the blueprint flow (including inside routes).
 * Does NOT search inside onerror arrays — the errored module is always in the main flow.
 */
export function findModuleById(flow: Module[], id: number): Module | null {
  for (const walked of walkModules(flow)) {
    if (walked.module.id === id) return walked.module;
  }
  return null;
}

/**
 * Extract the interface fields from a module's metadata.
 * Returns null if the module has no interface defined (e.g. simple utility modules).
 */
export function extractInterface(module: Module): InterfaceField[] | null {
  const iface = (module.metadata as any)?.interface;
  if (!Array.isArray(iface) || iface.length === 0) return null;
  return iface as InterfaceField[];
}

/**
 * Build the mapper for a builtin:Resume module from the errored module's interface.
 *
 * Each output field of the errored module is mapped from the retry module's output:
 *   "fieldName": "{{retryModuleId.fieldName}}"
 *
 * Special fields __IMTINDEX__ and __IMTLENGTH__ use backtick syntax in expressions
 * because their names contain double underscores.
 */
export function buildResumeMapper(
  iface: InterfaceField[],
  retryModuleId: number
): Record<string, string> {
  const mapper: Record<string, string> = {};

  for (const field of iface) {
    const name = field.name;
    // Fields starting and ending with __ need backtick quoting in Make expressions
    const needsBacktick = name.startsWith("__") && name.endsWith("__");
    const ref = needsBacktick
      ? `{{${retryModuleId}.\`${name}\`}}`
      : `{{${retryModuleId}.${name}}}`;
    mapper[name] = ref;
  }

  return mapper;
}

/**
 * Build a complete builtin:Resume module JSON.
 *
 * @param erroredModule   The module that can fail and will be retried
 * @param retryModuleId   The ID of the cloned retry module (after Sleep)
 * @param resumeId        The unique ID to assign to this Resume module
 * @param position        Designer coordinates { x, y }
 */
export function buildResumeModule(
  erroredModule: Module,
  retryModuleId: number,
  resumeId: number,
  position: { x: number; y: number }
): Record<string, unknown> {
  const iface = extractInterface(erroredModule);

  const mapper = iface ? buildResumeMapper(iface, retryModuleId) : {};
  const expect = iface ?? [];

  return {
    id: resumeId,
    module: "builtin:Resume",
    version: 1,
    parameters: {},
    mapper,
    metadata: {
      designer: { x: position.x, y: position.y },
      restore: {},
      expect,
    },
  };
}
