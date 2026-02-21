import { z } from "zod";

// --- Core module types ---

export const ModuleMetadataDesignerSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  name: z.string().optional(),
  messages: z.array(z.any()).optional(),
}).catchall(z.unknown());

export const ModuleMetadataSchema = z.object({
  designer: ModuleMetadataDesignerSchema.optional(),
  parameters: z.array(z.any()).optional(),
  expect: z.array(z.any()).optional(),
}).catchall(z.unknown());

export const FilterConditionSchema = z.object({
  a: z.any().optional(),
  b: z.any().optional(),
  o: z.string().optional(),
}).catchall(z.unknown());

export const FilterSchema = z.object({
  name: z.string().optional(),
  conditions: z.any().optional(),
}).catchall(z.unknown());

export const ErrorHandlerSchema: z.ZodType<any> = z.object({
  id: z.number(),
  module: z.string(),
  version: z.number().optional(),
  parameters: z.any().optional(),
  mapper: z.any().optional(),
  metadata: ModuleMetadataSchema.optional(),
}).catchall(z.unknown());

export const ModuleSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.number(),
    module: z.string(),
    version: z.number().optional(),
    name: z.string().nullable().optional(),
    mapper: z.any().optional(),
    metadata: ModuleMetadataSchema.optional(),
    parameters: z.any().optional(),
    filter: FilterSchema.nullable().optional(),
    onerror: z.array(ErrorHandlerSchema).nullable().optional(),
    routes: z.array(RouteSchema).nullable().optional(),
  }).catchall(z.unknown())
);

export const RouteSchema = z.object({
  flow: z.array(ModuleSchema).optional(),
}).catchall(z.unknown());

export const BlueprintSchedulingSchema = z.object({
  type: z.string().optional(),
  interval: z.number().optional(),
}).catchall(z.unknown());

export const BlueprintMetadataSchema = z.object({
  instant: z.boolean().optional(),
  version: z.number().optional(),
}).catchall(z.unknown());

export const BlueprintSchema = z.object({
  name: z.string(),
  flow: z.array(ModuleSchema),
  metadata: BlueprintMetadataSchema.optional(),
  scheduling: BlueprintSchedulingSchema.optional(),
}).catchall(z.unknown());

// --- Inferred types ---

export type Module = z.infer<typeof ModuleSchema>;
export type Route = z.infer<typeof RouteSchema>;
export type ErrorHandler = z.infer<typeof ErrorHandlerSchema>;
export type Blueprint = z.infer<typeof BlueprintSchema>;
export type ModuleMetadata = z.infer<typeof ModuleMetadataSchema>;

// --- Note types ---

export interface Note {
  id?: number;
  moduleIds: number[];
  content: string;
  createdByUser?: { name?: string; email?: string };
}

// --- Analysis types ---

export type IssueSeverity = "critical" | "warning" | "info";
export type IssueCategory =
  | "error-handling"
  | "naming"
  | "documentation"
  | "security"
  | "hardcoded-data"
  | "data-validation"
  | "json-safety"
  | "character-escaping"
  | "connection-validation"
  | "route-merging"
  | "handler-quality"
  | "scenario-naming";

export interface Issue {
  moduleId: number | null; // null for scenario-level issues
  moduleType: string | null;
  category: IssueCategory;
  severity: IssueSeverity;
  message: string; // Hebrew recommendation text
  autoFixable: boolean;
}

export type ModuleClassification = "excluded" | "trigger" | "api";

export interface ClassifiedModule {
  module: Module;
  classification: ModuleClassification;
  path: string; // e.g. "flow[0]" or "flow[0].routes[1].flow[2]"
}
