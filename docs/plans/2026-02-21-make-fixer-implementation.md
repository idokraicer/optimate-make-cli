# Make Fixer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a CLI tool that fetches Make.com scenario blueprints, analyzes them for quality issues, auto-fixes what it can, and pushes corrected blueprints back via API.

**Architecture:** Deterministic TypeScript analyzer replaces an existing LLM prompt. Auto-fixes are code-based JSON transformations. AI (Claude) is only used for generating human-readable content (module names, docs). Read-modify-write cycle via Make.com API preserves module IDs.

**Tech Stack:** Bun, TypeScript, `@anthropic-ai/sdk`, `commander`, `zod`

**Reference:** Design doc at `docs/plans/2026-02-21-make-fixer-design.md`

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.gitignore`

**Step 1: Initialize git and bun project**

```bash
cd ~/Developer/make-fixer
git init
bun init -y
```

**Step 2: Install dependencies**

```bash
bun add @anthropic-ai/sdk commander zod
bun add -d @types/bun
```

**Step 3: Configure tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "resolveJsonModule": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

**Step 4: Create .env.example and .gitignore**

`.env.example`:
```
MAKE_API_TOKEN=your_make_api_token_here
MAKE_BASE_URL=https://eu1.make.com/api/v2
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

`.gitignore`:
```
node_modules/
dist/
.env
*.log
```

**Step 5: Add bin entry and scripts to package.json**

Add to `package.json`:
```json
{
  "name": "make-fixer",
  "type": "module",
  "bin": {
    "make-fixer": "./src/cli.ts"
  },
  "scripts": {
    "start": "bun src/cli.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  }
}
```

**Step 6: Create placeholder CLI entry point**

`src/cli.ts`:
```ts
#!/usr/bin/env bun
console.log("make-fixer: not yet implemented");
```

**Step 7: Verify setup**

Run: `bun src/cli.ts`
Expected: `make-fixer: not yet implemented`

Run: `bun test`
Expected: No tests found (clean)

**Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold make-fixer project with deps"
```

---

### Task 2: Blueprint Types, Fixtures & Module Helpers

**Files:**
- Create: `src/make-api/types.ts`
- Create: `src/utils/module-helpers.ts`
- Create: `src/utils/module-helpers.test.ts`
- Create: `src/utils/blueprint-traversal.ts`
- Create: `src/utils/blueprint-traversal.test.ts`
- Create: `tests/fixtures/simple-blueprint.json`
- Create: `tests/fixtures/complex-blueprint.json`

**Step 1: Write the failing test for module helpers**

`src/utils/module-helpers.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { isExcludedModule, isTriggerModule, getMaxModuleId } from "./module-helpers";

describe("isExcludedModule", () => {
  test("excludes builtin modules", () => {
    expect(isExcludedModule("builtin:Router")).toBe(true);
    expect(isExcludedModule("builtin:BasicFilter")).toBe(true);
  });

  test("excludes gateway modules", () => {
    expect(isExcludedModule("gateway:CustomWebHook")).toBe(true);
    expect(isExcludedModule("gateway:WebhookRespond")).toBe(true);
  });

  test("excludes json modules", () => {
    expect(isExcludedModule("json:ParseJSON")).toBe(true);
    expect(isExcludedModule("json:CreateJSON")).toBe(true);
  });

  test("excludes tools modules", () => {
    expect(isExcludedModule("tools:SetVariables")).toBe(true);
    expect(isExcludedModule("tools:Compose")).toBe(true);
  });

  test("excludes util, flow, code, phonenumber modules", () => {
    expect(isExcludedModule("util:Switcher")).toBe(true);
    expect(isExcludedModule("flow:something")).toBe(true);
    expect(isExcludedModule("code:ExecuteCode")).toBe(true);
    expect(isExcludedModule("phonenumber:Parse")).toBe(true);
  });

  test("excludes Transformer modules", () => {
    expect(isExcludedModule("google-sheets:Transformer")).toBe(true);
    expect(isExcludedModule("monday:Transformer")).toBe(true);
  });

  test("does NOT exclude API modules", () => {
    expect(isExcludedModule("monday:ListBoardItems")).toBe(false);
    expect(isExcludedModule("powerlink:plquery")).toBe(false);
    expect(isExcludedModule("gmail:sendEmail")).toBe(false);
    expect(isExcludedModule("http:ActionSendData")).toBe(false);
    expect(isExcludedModule("green-api:SendMessage")).toBe(false);
  });
});

describe("getMaxModuleId", () => {
  test("finds highest ID in flat flow", () => {
    const flow = [
      { id: 1, module: "a:b" },
      { id: 5, module: "c:d" },
      { id: 3, module: "e:f" },
    ] as any;
    expect(getMaxModuleId(flow)).toBe(5);
  });

  test("finds highest ID including onerror handlers", () => {
    const flow = [
      { id: 1, module: "a:b", onerror: [{ id: 10, module: "builtin:Break" }] },
      { id: 5, module: "c:d" },
    ] as any;
    expect(getMaxModuleId(flow)).toBe(10);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/utils/module-helpers.test.ts`
Expected: FAIL — module not found

**Step 3: Define Blueprint types**

`src/make-api/types.ts`:
```ts
import { z } from "zod";

// --- Core module types ---

export const ModuleMetadataDesignerSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  name: z.string().optional(),
  messages: z.array(z.any()).optional(),
}).passthrough();

export const ModuleMetadataSchema = z.object({
  designer: ModuleMetadataDesignerSchema.optional(),
  parameters: z.array(z.any()).optional(),
  expect: z.array(z.any()).optional(),
}).passthrough();

export const FilterConditionSchema = z.object({
  a: z.any().optional(),
  b: z.any().optional(),
  o: z.string().optional(),
}).passthrough();

export const FilterSchema = z.object({
  name: z.string().optional(),
  conditions: z.any().optional(),
}).passthrough();

export const ErrorHandlerSchema: z.ZodType<any> = z.object({
  id: z.number(),
  module: z.string(),
  version: z.number().optional(),
  parameters: z.any().optional(),
  mapper: z.any().optional(),
  metadata: ModuleMetadataSchema.optional(),
}).passthrough();

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
  }).passthrough()
);

export const RouteSchema = z.object({
  flow: z.array(ModuleSchema).optional(),
}).passthrough();

export const BlueprintSchedulingSchema = z.object({
  type: z.string().optional(),
  interval: z.number().optional(),
}).passthrough();

export const BlueprintMetadataSchema = z.object({
  instant: z.boolean().optional(),
  version: z.number().optional(),
}).passthrough();

export const BlueprintSchema = z.object({
  name: z.string(),
  flow: z.array(ModuleSchema),
  metadata: BlueprintMetadataSchema.optional(),
  scheduling: BlueprintSchedulingSchema.optional(),
}).passthrough();

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
```

**Step 4: Implement module helpers**

`src/utils/module-helpers.ts`:
```ts
import type { Module } from "../make-api/types";

const EXCLUDED_PREFIXES = [
  "builtin:",
  "gateway:",
  "json:",
  "tools:",
  "util:",
  "flow:",
  "code:",
  "phonenumber:",
];

export function isExcludedModule(moduleType: string): boolean {
  if (EXCLUDED_PREFIXES.some((prefix) => moduleType.startsWith(prefix))) {
    return true;
  }
  if (moduleType.includes(":Transformer")) {
    return true;
  }
  return false;
}

export function isTriggerModule(module: Module, flow: Module[]): boolean {
  return flow.length > 0 && flow[0].id === module.id;
}

export function hasCustomName(module: Module): boolean {
  return (
    typeof module.metadata?.designer?.name === "string" &&
    module.metadata.designer.name.trim().length > 0
  );
}

export function hasErrorHandler(module: Module): boolean {
  return Array.isArray(module.onerror) && module.onerror.length > 0;
}

export function getModuleCustomName(module: Module): string | null {
  return module.metadata?.designer?.name?.trim() || null;
}

export function getMaxModuleId(flow: Module[]): number {
  let max = 0;
  for (const mod of flow) {
    if (mod.id > max) max = mod.id;
    if (Array.isArray(mod.onerror)) {
      for (const handler of mod.onerror) {
        if (handler.id > max) max = handler.id;
      }
    }
    if (Array.isArray(mod.routes)) {
      for (const route of mod.routes) {
        if (Array.isArray(route.flow)) {
          const routeMax = getMaxModuleId(route.flow);
          if (routeMax > max) max = routeMax;
        }
      }
    }
  }
  return max;
}

/** Translate module type string to Hebrew label for recommendations */
export function translateModuleType(moduleType: string): string {
  const TRANSLATIONS: Record<string, string> = {
    "monday:ListBoardItems": "Monday - שליפת פריטים",
    "monday:createItem2": "Monday - יצירת פריט",
    "monday:ChangeMultipleColumnValues": "Monday - עדכון שדות",
    "powerlink:plquery": "Fireberry - שליפת נתונים",
    "powerlink:updateObject": "Fireberry - עדכון נתונים",
    "powerlink:createObject": "Fireberry - יצירת אובייקט",
    "powerlink:createobject": "Fireberry - יצירת אובייקט",
    "gmail:sendEmail": "Gmail - שליחת אימייל",
    "http:ActionSendData": "HTTP - שליחת נתונים",
    "http:MakeRequest": "HTTP - קריאה חיצונית",
    "green-api:SendMessage": "WhatsApp - שליחת הודעה",
    "green-api:Webhook": "WhatsApp - וובהוק",
  };

  if (TRANSLATIONS[moduleType]) return TRANSLATIONS[moduleType];

  // Generic translation: "service:action" → "Service - action"
  const [service, action] = moduleType.split(":");
  const SERVICE_MAP: Record<string, string> = {
    powerlink: "Fireberry",
    "green-api": "WhatsApp",
    "google-drive": "Google Drive",
    "google-calendar": "Google Calendar",
    "google-sheets": "Google Sheet",
    http: "HTTP",
    monday: "Monday",
    gmail: "Gmail",
    woocommerce: "Woocommerce",
    openai: "OpenAI",
    airtable: "Airtable",
    manychat: "ManyChat",
    fireberry: "Fireberry",
  };

  const serviceName = SERVICE_MAP[service] || service;
  return `${serviceName} - ${action || "unknown"}`;
}

/** Extract service prefix from module type (e.g. "monday" from "monday:ListBoardItems") */
export function getServicePrefix(moduleType: string): string {
  return moduleType.split(":")[0];
}
```

**Step 5: Run tests to verify they pass**

Run: `bun test src/utils/module-helpers.test.ts`
Expected: All PASS

**Step 6: Write failing test for blueprint traversal**

`src/utils/blueprint-traversal.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { walkModules } from "./blueprint-traversal";
import type { Module } from "../make-api/types";

const makeModule = (id: number, module: string, extras: Partial<Module> = {}): Module => ({
  id,
  module,
  ...extras,
});

describe("walkModules", () => {
  test("walks flat flow", () => {
    const flow = [makeModule(1, "gateway:CustomWebHook"), makeModule(2, "monday:ListBoardItems")];
    const result = walkModules(flow);
    expect(result).toHaveLength(2);
    expect(result[0].module.id).toBe(1);
    expect(result[0].path).toBe("flow[0]");
    expect(result[1].path).toBe("flow[1]");
  });

  test("walks nested routes", () => {
    const flow = [
      makeModule(1, "gateway:CustomWebHook"),
      makeModule(2, "builtin:Router", {
        routes: [
          { flow: [makeModule(3, "monday:createItem2")] },
          { flow: [makeModule(4, "gmail:sendEmail")] },
        ],
      }),
    ];
    const result = walkModules(flow);
    expect(result).toHaveLength(4);
    expect(result.find((r) => r.module.id === 3)?.path).toBe("flow[1].routes[0].flow[0]");
    expect(result.find((r) => r.module.id === 4)?.path).toBe("flow[1].routes[1].flow[0]");
  });

  test("walks deeply nested routes", () => {
    const flow = [
      makeModule(1, "gateway:CustomWebHook"),
      makeModule(2, "builtin:Router", {
        routes: [
          {
            flow: [
              makeModule(3, "builtin:Router", {
                routes: [{ flow: [makeModule(4, "http:ActionSendData")] }],
              }),
            ],
          },
        ],
      }),
    ];
    const result = walkModules(flow);
    const deep = result.find((r) => r.module.id === 4);
    expect(deep?.path).toBe("flow[1].routes[0].flow[0].routes[0].flow[0]");
  });
});
```

**Step 7: Implement blueprint traversal**

`src/utils/blueprint-traversal.ts`:
```ts
import type { Module } from "../make-api/types";

export interface WalkedModule {
  module: Module;
  path: string;
  depth: number;
}

/**
 * Recursively walk all modules in a blueprint flow, including nested routes.
 * Returns a flat list with path information for each module.
 */
export function walkModules(flow: Module[], basePath = "flow", depth = 0): WalkedModule[] {
  const result: WalkedModule[] = [];

  for (let i = 0; i < flow.length; i++) {
    const mod = flow[i];
    const path = `${basePath}[${i}]`;
    result.push({ module: mod, path, depth });

    if (Array.isArray(mod.routes)) {
      for (let r = 0; r < mod.routes.length; r++) {
        const route = mod.routes[r];
        if (Array.isArray(route.flow)) {
          const routePath = `${path}.routes[${r}].flow`;
          result.push(...walkModules(route.flow, routePath, depth + 1));
        }
      }
    }
  }

  return result;
}
```

**Step 8: Run all tests**

Run: `bun test`
Expected: All PASS

**Step 9: Create test fixtures**

`tests/fixtures/simple-blueprint.json`:
```json
{
  "name": "Test Scenario",
  "flow": [
    {
      "id": 1,
      "module": "gateway:CustomWebHook",
      "version": 1,
      "metadata": {
        "designer": { "x": 0, "y": 0 }
      }
    },
    {
      "id": 2,
      "module": "powerlink:plquery",
      "version": 1,
      "mapper": {
        "query": "{{1.phone}}"
      },
      "metadata": {
        "designer": { "x": 300, "y": 0 }
      },
      "onerror": null
    },
    {
      "id": 3,
      "module": "powerlink:updateObject",
      "version": 1,
      "mapper": {},
      "metadata": {
        "designer": { "x": 600, "y": 0, "name": "Update Contact" }
      },
      "onerror": [
        {
          "id": 4,
          "module": "builtin:Break",
          "version": 1,
          "mapper": { "retry": true, "count": 3, "interval": 60 }
        }
      ]
    }
  ],
  "metadata": { "instant": true },
  "scheduling": { "type": "immediately" }
}
```

`tests/fixtures/complex-blueprint.json`:
```json
{
  "name": "Sync",
  "flow": [
    {
      "id": 1,
      "module": "gateway:CustomWebHook",
      "version": 1,
      "metadata": { "designer": { "x": 0, "y": 0 } }
    },
    {
      "id": 2,
      "module": "json:ParseJSON",
      "version": 1,
      "metadata": { "designer": { "x": 150, "y": 0 } }
    },
    {
      "id": 3,
      "module": "builtin:Router",
      "version": 1,
      "metadata": { "designer": { "x": 300, "y": 0 } },
      "routes": [
        {
          "flow": [
            {
              "id": 5,
              "module": "powerlink:plquery",
              "version": 1,
              "mapper": { "query": "{{1.email}}" },
              "metadata": { "designer": { "x": 600, "y": -150 } },
              "onerror": null
            },
            {
              "id": 6,
              "module": "powerlink:createObject",
              "version": 1,
              "mapper": {},
              "metadata": { "designer": { "x": 900, "y": -150 } },
              "onerror": null
            }
          ]
        },
        {
          "flow": [
            {
              "id": 7,
              "module": "http:ActionSendData",
              "version": 1,
              "mapper": {
                "url": "https://api.example.com/webhook",
                "body": "{\"name\": \"{{1.name}}\", \"phone\": \"{{1.phone}}\"}"
              },
              "metadata": { "designer": { "x": 600, "y": 150 } },
              "onerror": null
            },
            {
              "id": 8,
              "module": "gmail:sendEmail",
              "version": 1,
              "mapper": { "to": "admin@example.com" },
              "metadata": { "designer": { "x": 900, "y": 150 } },
              "onerror": null
            }
          ]
        }
      ]
    }
  ],
  "metadata": { "instant": true },
  "scheduling": { "type": "immediately" }
}
```

**Step 10: Commit**

```bash
git add -A
git commit -m "feat: add blueprint types, module helpers, and traversal"
```

---

### Task 3: Make.com API Client

**Files:**
- Create: `src/make-api/client.ts`
- Create: `src/make-api/client.test.ts`

**Step 1: Write failing test**

`src/make-api/client.test.ts`:
```ts
import { describe, expect, test, mock, beforeEach } from "bun:test";
import { MakeApiClient } from "./client";

// We'll test the URL construction and request shaping, not actual HTTP calls

describe("MakeApiClient", () => {
  test("constructs correct blueprint URL", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com/api/v2",
    });
    expect(client.getBlueprintUrl(12345)).toBe(
      "https://eu1.make.com/api/v2/scenarios/12345/blueprint"
    );
  });

  test("constructs correct scenario URL for patching", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com/api/v2",
    });
    expect(client.getScenarioUrl(12345)).toBe(
      "https://eu1.make.com/api/v2/scenarios/12345"
    );
  });

  test("strips trailing slash from base URL", () => {
    const client = new MakeApiClient({
      token: "test-token",
      baseUrl: "https://eu1.make.com/api/v2/",
    });
    expect(client.getBlueprintUrl(1)).toBe(
      "https://eu1.make.com/api/v2/scenarios/1/blueprint"
    );
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test src/make-api/client.test.ts`
Expected: FAIL

**Step 3: Implement the client**

`src/make-api/client.ts`:
```ts
import { BlueprintSchema, type Blueprint, type Note } from "./types";

export interface MakeApiConfig {
  token: string;
  baseUrl: string;
}

export class MakeApiClient {
  private token: string;
  private baseUrl: string;

  constructor(config: MakeApiConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  getBlueprintUrl(scenarioId: number): string {
    return `${this.baseUrl}/scenarios/${scenarioId}/blueprint`;
  }

  getScenarioUrl(scenarioId: number): string {
    return `${this.baseUrl}/scenarios/${scenarioId}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Token ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  async fetchBlueprint(scenarioId: number): Promise<{ blueprint: Blueprint; raw: any }> {
    const res = await fetch(this.getBlueprintUrl(scenarioId), {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Make API error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();

    // The API returns { response: { blueprint: {...} } } or { blueprint: "..." }
    // The blueprint may be a JSON string or an object depending on endpoint
    let blueprintData: any;
    if (data.response?.blueprint) {
      blueprintData = data.response.blueprint;
    } else if (data.blueprint) {
      blueprintData =
        typeof data.blueprint === "string" ? JSON.parse(data.blueprint) : data.blueprint;
    } else {
      blueprintData = data;
    }

    const blueprint = BlueprintSchema.parse(blueprintData);
    return { blueprint, raw: data };
  }

  async pushBlueprint(scenarioId: number, blueprint: Blueprint): Promise<void> {
    const body = JSON.stringify({
      blueprint: JSON.stringify(blueprint),
    });

    const res = await fetch(this.getScenarioUrl(scenarioId), {
      method: "PATCH",
      headers: this.headers(),
      body,
    });

    if (!res.ok) {
      throw new Error(`Make API PATCH error ${res.status}: ${await res.text()}`);
    }
  }

  async fetchNotes(scenarioId: number): Promise<Note[]> {
    // Notes endpoint is not well-documented — attempt to fetch
    // If it fails, return empty array (notes are optional for fixes)
    try {
      const res = await fetch(`${this.baseUrl}/scenarios/${scenarioId}/notes`, {
        headers: this.headers(),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.notes) ? data.notes : [];
    } catch {
      return [];
    }
  }
}
```

**Step 4: Run tests**

Run: `bun test src/make-api/client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Make.com API client"
```

---

### Task 4: Module Classifier

**Files:**
- Create: `src/analyzer/module-classifier.ts`
- Create: `src/analyzer/module-classifier.test.ts`

**Step 1: Write failing test**

`src/analyzer/module-classifier.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { classifyModules } from "./module-classifier";
import simpleBlueprint from "../../tests/fixtures/simple-blueprint.json";
import complexBlueprint from "../../tests/fixtures/complex-blueprint.json";
import type { Blueprint } from "../make-api/types";

describe("classifyModules", () => {
  test("classifies trigger module correctly", () => {
    const result = classifyModules(simpleBlueprint as Blueprint);
    const trigger = result.find((r) => r.module.id === 1);
    expect(trigger?.classification).toBe("trigger");
  });

  test("classifies excluded modules correctly", () => {
    const result = classifyModules(complexBlueprint as Blueprint);
    const router = result.find((r) => r.module.id === 3);
    expect(router?.classification).toBe("excluded");
    const jsonModule = result.find((r) => r.module.id === 2);
    expect(jsonModule?.classification).toBe("excluded");
  });

  test("classifies API modules correctly", () => {
    const result = classifyModules(simpleBlueprint as Blueprint);
    const apiModule = result.find((r) => r.module.id === 2);
    expect(apiModule?.classification).toBe("api");
  });

  test("finds all modules in nested routes", () => {
    const result = classifyModules(complexBlueprint as Blueprint);
    // Should find: 1 (trigger), 2 (excluded json), 3 (excluded router),
    // 5, 6 (api powerlink), 7 (api http), 8 (api gmail)
    expect(result).toHaveLength(7);
    const apiModules = result.filter((r) => r.classification === "api");
    expect(apiModules).toHaveLength(4);
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test src/analyzer/module-classifier.test.ts`
Expected: FAIL

**Step 3: Implement classifier**

`src/analyzer/module-classifier.ts`:
```ts
import type { Blueprint, ClassifiedModule, Module } from "../make-api/types";
import { isExcludedModule } from "../utils/module-helpers";
import { walkModules } from "../utils/blueprint-traversal";

export function classifyModules(blueprint: Blueprint): ClassifiedModule[] {
  const walked = walkModules(blueprint.flow);
  const triggerId = blueprint.flow.length > 0 ? blueprint.flow[0].id : null;

  return walked.map(({ module, path }) => {
    let classification: ClassifiedModule["classification"];

    if (module.id === triggerId) {
      classification = "trigger";
    } else if (isExcludedModule(module.module)) {
      classification = "excluded";
    } else {
      classification = "api";
    }

    return { module, classification, path };
  });
}
```

**Step 4: Run tests**

Run: `bun test src/analyzer/module-classifier.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add module classifier"
```

---

### Task 5: Analyzer Checks — Error Handling & Naming

**Files:**
- Create: `src/analyzer/checks/error-handling.ts`
- Create: `src/analyzer/checks/error-handling.test.ts`
- Create: `src/analyzer/checks/naming.ts`
- Create: `src/analyzer/checks/naming.test.ts`
- Create: `src/analyzer/checks/scenario-naming.ts`
- Create: `src/analyzer/checks/scenario-naming.test.ts`

**Step 1: Write failing test for error handling check**

`src/analyzer/checks/error-handling.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { checkErrorHandling } from "./error-handling";
import { classifyModules } from "../module-classifier";
import simpleBlueprint from "../../../tests/fixtures/simple-blueprint.json";
import complexBlueprint from "../../../tests/fixtures/complex-blueprint.json";
import type { Blueprint } from "../../make-api/types";

describe("checkErrorHandling", () => {
  test("flags API modules without error handlers", () => {
    const classified = classifyModules(simpleBlueprint as Blueprint);
    const issues = checkErrorHandling(classified);
    // Module 2 (powerlink:plquery) has onerror: null → should be flagged
    // Module 3 (powerlink:updateObject) has onerror with Break → should NOT be flagged
    expect(issues).toHaveLength(1);
    expect(issues[0].moduleId).toBe(2);
    expect(issues[0].category).toBe("error-handling");
    expect(issues[0].autoFixable).toBe(true);
  });

  test("does NOT flag trigger module", () => {
    const classified = classifyModules(simpleBlueprint as Blueprint);
    const issues = checkErrorHandling(classified);
    const triggerIssue = issues.find((i) => i.moduleId === 1);
    expect(triggerIssue).toBeUndefined();
  });

  test("flags multiple modules in complex blueprint", () => {
    const classified = classifyModules(complexBlueprint as Blueprint);
    const issues = checkErrorHandling(classified);
    // Modules 5, 6, 7, 8 all have onerror: null
    expect(issues).toHaveLength(4);
    const ids = issues.map((i) => i.moduleId).sort();
    expect(ids).toEqual([5, 6, 7, 8]);
  });
});
```

**Step 2: Implement error handling check**

`src/analyzer/checks/error-handling.ts`:
```ts
import type { ClassifiedModule, Issue } from "../../make-api/types";
import { hasErrorHandler, translateModuleType } from "../../utils/module-helpers";

export function checkErrorHandling(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification !== "api") continue;

    if (!hasErrorHandler(module)) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "error-handling",
        severity: "warning",
        message: `מודול ${module.id} - ${label} - חסר טיפול בשגיאות. יש להוסיף error handler מסוג Break (או Resume/Ignore לפי הקונטקסט)`,
        autoFixable: true,
      });
    }
  }

  return issues;
}
```

**Step 3: Run error handling tests**

Run: `bun test src/analyzer/checks/error-handling.test.ts`
Expected: PASS

**Step 4: Write failing test for naming check**

`src/analyzer/checks/naming.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { checkNaming } from "./naming";
import { classifyModules } from "../module-classifier";
import simpleBlueprint from "../../../tests/fixtures/simple-blueprint.json";
import type { Blueprint } from "../../make-api/types";

describe("checkNaming", () => {
  test("flags API modules without custom names", () => {
    const classified = classifyModules(simpleBlueprint as Blueprint);
    const issues = checkNaming(classified);
    // Module 2 (powerlink:plquery) has no metadata.designer.name → flagged
    // Module 3 (powerlink:updateObject) has name "Update Contact" → NOT flagged
    expect(issues).toHaveLength(1);
    expect(issues[0].moduleId).toBe(2);
    expect(issues[0].category).toBe("naming");
    expect(issues[0].autoFixable).toBe(true);
  });

  test("does NOT flag excluded modules", () => {
    const classified = classifyModules(simpleBlueprint as Blueprint);
    const issues = checkNaming(classified);
    const excludedIssue = issues.find((i) => i.moduleId === 1);
    // Module 1 is trigger (gateway:CustomWebHook) — trigger IS checked for naming
    // but it has no name so it should be flagged
    // Actually, trigger modules ARE included in naming checks per the design
    // gateway:CustomWebHook IS excluded as a module type though
    expect(excludedIssue).toBeUndefined();
  });
});
```

**Step 5: Implement naming check**

`src/analyzer/checks/naming.ts`:
```ts
import type { ClassifiedModule, Issue } from "../../make-api/types";
import { hasCustomName, translateModuleType } from "../../utils/module-helpers";

export function checkNaming(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    // Check API modules and trigger modules (if trigger is not an excluded type)
    // But excluded module types are already classified as "excluded" by the classifier
    // Trigger modules that are gateway:* are classified as "trigger" not "excluded"
    // Per the design: triggers ARE included in naming checks
    if (classification === "excluded") continue;

    if (!hasCustomName(module)) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "naming",
        severity: "info",
        message: `מודול ${module.id} - ${label} - משתמש בשם ברירת מחדל. יש להגדיר שם מותאם אישית המתאר את תפקיד המודול`,
        autoFixable: true,
      });
    }
  }

  return issues;
}
```

**Step 6: Run naming tests**

Run: `bun test src/analyzer/checks/naming.test.ts`
Expected: PASS

**Step 7: Write failing test for scenario naming**

`src/analyzer/checks/scenario-naming.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { checkScenarioNaming } from "./scenario-naming";
import type { Blueprint } from "../../make-api/types";

describe("checkScenarioNaming", () => {
  test("flags short, vague names", () => {
    const issues = checkScenarioNaming({ name: "Sync" } as Blueprint);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe("scenario-naming");
    expect(issues[0].autoFixable).toBe(true);
  });

  test("flags generic names", () => {
    const issues = checkScenarioNaming({ name: "Test" } as Blueprint);
    expect(issues).toHaveLength(1);
  });

  test("does NOT flag descriptive names", () => {
    const issues = checkScenarioNaming({
      name: "Order Function: (Wordpress?) -> Fireberry -> Bingo Dashboard",
    } as Blueprint);
    expect(issues).toHaveLength(0);
  });

  test("does NOT flag names with good context", () => {
    const issues = checkScenarioNaming({
      name: "New Lead from Website Form -> Create in Fireberry + Send WhatsApp Alert",
    } as Blueprint);
    expect(issues).toHaveLength(0);
  });
});
```

**Step 8: Implement scenario naming check**

`src/analyzer/checks/scenario-naming.ts`:
```ts
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

  // Length >= 20 chars
  if (name.length >= 20) score++;

  // Contains source/trigger context
  const triggerPatterns = ["webhook", "from", "new ", "when", "on ", "receiving", "trigger"];
  if (triggerPatterns.some((p) => lower.includes(p))) score++;

  // Contains target/destination
  const targetPatterns = ["->", "to ", "into ", "in ", "→"];
  if (targetPatterns.some((p) => lower.includes(p))) score++;

  // Contains action verb
  if (ACTION_VERBS.some((v) => lower.includes(v))) score++;

  // Contains business context
  if (BUSINESS_OBJECTS.some((o) => lower.includes(o))) score++;

  // Descriptive enough (multiple words, explains flow)
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
```

**Step 9: Run all tests**

Run: `bun test`
Expected: All PASS

**Step 10: Commit**

```bash
git add -A
git commit -m "feat: add error handling, naming, and scenario naming checks"
```

---

### Task 6: Analyzer Checks — Security, Hardcoded Data, Documentation

**Files:**
- Create: `src/analyzer/checks/security.ts`
- Create: `src/analyzer/checks/security.test.ts`
- Create: `src/analyzer/checks/hardcoded.ts`
- Create: `src/analyzer/checks/hardcoded.test.ts`
- Create: `src/analyzer/checks/documentation.ts`
- Create: `src/analyzer/checks/documentation.test.ts`

**Step 1: Write failing test for security check**

`src/analyzer/checks/security.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { checkSecurity } from "./security";
import { classifyModules } from "../module-classifier";
import type { Blueprint } from "../../make-api/types";

describe("checkSecurity", () => {
  test("flags hardcoded API keys in mapper", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "http:ActionSendData",
          mapper: {
            headers: [{ name: "Authorization", value: "Bearer sk-1234567890abcdef" }],
          },
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkSecurity(classified);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe("critical");
  });

  test("does NOT flag connection references", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "http:ActionSendData",
          mapper: {
            headers: [{ name: "Authorization", value: "{{connection.token}}" }],
          },
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkSecurity(classified);
    expect(issues).toHaveLength(0);
  });
});
```

**Step 2: Implement security check**

`src/analyzer/checks/security.ts`:
```ts
import type { ClassifiedModule, Issue } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

const SENSITIVE_KEYS = ["authorization", "api_key", "apikey", "token", "password", "secret", "api-key"];
const SAFE_PATTERNS = ["{{connection.", "{{variables.", "{{parameters."];

function containsHardcodedSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 8) return false;
  if (SAFE_PATTERNS.some((p) => value.includes(p))) return false;
  // Check if it looks like a raw token/key (not a template variable)
  if (value.startsWith("{{") && value.endsWith("}}")) return false;
  return true;
}

function scanMapper(mapper: any): string[] {
  const findings: string[] = [];
  if (!mapper || typeof mapper !== "object") return findings;

  const scan = (obj: any, path: string) => {
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => scan(item, `${path}[${i}]`));
      return;
    }
    if (obj && typeof obj === "object") {
      for (const [key, value] of Object.entries(obj)) {
        const keyLower = key.toLowerCase();
        if (SENSITIVE_KEYS.some((sk) => keyLower.includes(sk))) {
          if (containsHardcodedSecret(value)) {
            findings.push(key);
          }
        }
        scan(value, `${path}.${key}`);
      }
    }
  };

  scan(mapper, "mapper");
  return findings;
}

export function checkSecurity(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification === "excluded") continue;

    const findings = scanMapper(module.mapper);
    if (findings.length > 0) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "security",
        severity: "critical",
        message: `⚠️ קריטי - מודול ${module.id} - ${label} - מכיל API Key חשוף! יש ליצור Connection או לאחסן במשתנה מאובטח מיידית`,
        autoFixable: false,
      });
    }
  }

  return issues;
}
```

**Step 3: Write failing test for hardcoded data check**

`src/analyzer/checks/hardcoded.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { checkHardcodedData } from "./hardcoded";
import { classifyModules } from "../module-classifier";
import type { Blueprint } from "../../make-api/types";

describe("checkHardcodedData", () => {
  test("flags long hardcoded lists in filters", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "builtin:Router",
          routes: [
            {
              flow: [
                {
                  id: 3,
                  module: "powerlink:plquery",
                  filter: {
                    name: "Phone filter",
                    conditions: [[{
                      a: '{{contains(split("0547803904,0546210188,0526212469,0541234567,0552345678,0561234567,0571234567,0581234567,0591234567,0501234567,0511234567"; ","); 1.phone)}}',
                      o: "boolean:true",
                    }]],
                  },
                },
              ],
            },
          ],
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkHardcodedData(classified);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].category).toBe("hardcoded-data");
  });

  test("does NOT flag short lists", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "powerlink:plquery",
          filter: {
            conditions: [[{ a: '{{split("a,b,c"; ",")}}', o: "boolean:true" }]],
          },
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkHardcodedData(classified);
    expect(issues).toHaveLength(0);
  });
});
```

**Step 4: Implement hardcoded data check**

`src/analyzer/checks/hardcoded.ts`:
```ts
import type { ClassifiedModule, Issue } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

const MIN_ITEMS_THRESHOLD = 10;

function findLongLists(obj: unknown, path = ""): { path: string; count: number; sample: string }[] {
  const findings: { path: string; count: number; sample: string }[] = [];
  if (typeof obj === "string") {
    // Look for split("long,list,..."; ",") patterns
    const splitMatch = obj.match(/split\("([^"]{50,})"\s*;\s*"[,;|]"\)/);
    if (splitMatch) {
      const items = splitMatch[1].split(/[,;|]/);
      if (items.length >= MIN_ITEMS_THRESHOLD) {
        findings.push({ path, count: items.length, sample: items.slice(0, 3).join(",") + "..." });
      }
    }
    // Look for plain long comma-separated values
    const commaItems = obj.split(",");
    if (commaItems.length >= MIN_ITEMS_THRESHOLD && obj.length > 100 && !obj.includes("{{")) {
      findings.push({ path, count: commaItems.length, sample: commaItems.slice(0, 3).join(",") + "..." });
    }
  } else if (Array.isArray(obj)) {
    obj.forEach((item, i) => findings.push(...findLongLists(item, `${path}[${i}]`)));
  } else if (obj && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      findings.push(...findLongLists(value, `${path}.${key}`));
    }
  }
  return findings;
}

export function checkHardcodedData(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module } of classified) {
    const sources = [module.filter, module.mapper].filter(Boolean);
    for (const source of sources) {
      const findings = findLongLists(source);
      for (const finding of findings) {
        const label = translateModuleType(module.module);
        issues.push({
          moduleId: module.id,
          moduleType: module.module,
          category: "hardcoded-data",
          severity: "warning",
          message: `מודול ${module.id} - ${label} - זוהה מידע קבוע (Hardcoded) בכמות גדולה: ${finding.count} ערכים (${finding.sample}). מומלץ לשלוף את המידע באופן דינמי מ-Fireberry/Monday/מקור נתונים אחר`,
          autoFixable: false,
        });
      }
    }
  }

  return issues;
}
```

**Step 5: Write failing test for documentation check**

`src/analyzer/checks/documentation.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { checkDocumentation } from "./documentation";
import { classifyModules } from "../module-classifier";
import type { Blueprint, Note } from "../../make-api/types";

describe("checkDocumentation", () => {
  test("flags HTTP modules without documentation", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "http:ActionSendData" },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const notes: Note[] = [];
    const issues = checkDocumentation(classified, notes);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].moduleId).toBe(2);
  });

  test("does NOT flag standard API modules without docs", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "powerlink:plquery" },
        { id: 3, module: "gmail:sendEmail" },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkDocumentation(classified, []);
    expect(issues).toHaveLength(0);
  });

  test("does NOT flag HTTP modules WITH valid English documentation", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "http:ActionSendData" },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const notes: Note[] = [
      { moduleIds: [2], content: "Sends order data to the external fulfillment API" },
    ];
    const issues = checkDocumentation(classified, notes);
    expect(issues).toHaveLength(0);
  });

  test("flags HTTP modules with Hebrew-only documentation", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "http:ActionSendData" },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const notes: Note[] = [
      { moduleIds: [2], content: "שולח נתונים לשרת חיצוני" },
    ];
    const issues = checkDocumentation(classified, notes);
    expect(issues).toHaveLength(1);
  });

  test("flags HTTP modules with too-short documentation", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "http:ActionSendData" },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const notes: Note[] = [{ moduleIds: [2], content: "sends data" }];
    const issues = checkDocumentation(classified, notes);
    expect(issues).toHaveLength(1);
  });
});
```

**Step 6: Implement documentation check**

`src/analyzer/checks/documentation.ts`:
```ts
import type { ClassifiedModule, Issue, Note } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

const REQUIRES_DOCUMENTATION_PREFIXES = ["http:", "manychat:"];
const HEBREW_REGEX = /[\u0590-\u05FF]/;
const MIN_DOC_LENGTH = 15;

function requiresDocumentation(moduleType: string, classification: string): boolean {
  // HTTP and ManyChat modules require documentation
  if (REQUIRES_DOCUMENTATION_PREFIXES.some((p) => moduleType.startsWith(p))) return true;
  // Webhook triggers (gateway:CustomWebHook as trigger) require documentation
  if (classification === "trigger" && moduleType.startsWith("gateway:")) return true;
  return false;
}

function stripHtml(content: string): string {
  return content.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function isValidDocumentation(content: string): boolean {
  const stripped = stripHtml(content);
  if (stripped.length <= MIN_DOC_LENGTH) return false;
  if (HEBREW_REGEX.test(stripped)) return false;
  return true;
}

export function checkDocumentation(classified: ClassifiedModule[], notes: Note[]): Issue[] {
  const issues: Issue[] = [];

  // Build set of documented module IDs
  const documentedModuleIds = new Set<number>();
  const noteContentByModuleId = new Map<number, string>();
  for (const note of notes) {
    for (const moduleId of note.moduleIds) {
      documentedModuleIds.add(moduleId);
      noteContentByModuleId.set(moduleId, note.content);
    }
  }

  for (const { module, classification } of classified) {
    if (!requiresDocumentation(module.module, classification)) continue;

    const content = noteContentByModuleId.get(module.id);
    if (!content || !isValidDocumentation(content)) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "documentation",
        severity: "info",
        message: `מודול ${module.id} - ${label} - חסר תיעוד באנגלית (מעל 15 תווים). יש להוסיף הערה מפורטת המסבירה את תפקיד המודול`,
        autoFixable: true,
      });
    }
  }

  return issues;
}
```

**Step 7: Run all tests**

Run: `bun test`
Expected: All PASS

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: add security, hardcoded data, and documentation checks"
```

---

### Task 7: Analyzer Checks — Remaining (Data Validation, JSON Safety, Handler Quality, Connection, Route Merging)

**Files:**
- Create: `src/analyzer/checks/data-validation.ts`
- Create: `src/analyzer/checks/json-safety.ts`
- Create: `src/analyzer/checks/handler-quality.ts`
- Create: `src/analyzer/checks/connection-validation.ts`
- Create: `src/analyzer/checks/route-merging.ts`
- Create: `src/analyzer/checks/data-validation.test.ts`
- Create: `src/analyzer/checks/handler-quality.test.ts`

**Step 1: Implement data validation check**

`src/analyzer/checks/data-validation.ts`:
```ts
import type { ClassifiedModule, Issue } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

const QUERY_ACTIONS = ["plquery", "query", "get", "search", "list", "read", "fetch", "find", "listboarditems", "getitem"];
const WEBHOOK_DATA_PATTERN = /\{\{[12]\.\w+\}\}/;
const SAFE_WRAPPERS = ["ifempty(", "if(", "emptystring("];

function usesWebhookDataUnsafely(mapper: any): boolean {
  if (!mapper || typeof mapper !== "object") return false;
  const str = JSON.stringify(mapper);
  if (!WEBHOOK_DATA_PATTERN.test(str)) return false;
  // Check if all references are wrapped in safe functions
  const refs = str.match(/\{\{[12]\.\w+\}\}/g) || [];
  for (const ref of refs) {
    // Find the context around this reference
    const idx = str.indexOf(ref);
    const before = str.substring(Math.max(0, idx - 30), idx).toLowerCase();
    if (!SAFE_WRAPPERS.some((w) => before.includes(w))) {
      return true; // Unsafe reference found
    }
  }
  return false;
}

export function checkDataValidation(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification !== "api") continue;

    const action = module.module.split(":")[1]?.toLowerCase() || "";
    if (!QUERY_ACTIONS.some((q) => action.includes(q))) continue;

    if (usesWebhookDataUnsafely(module.mapper)) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "data-validation",
        severity: "warning",
        message: `מודול ${module.id} - ${label} - משתמש בנתונים מוובהוק ללא בדיקת קיום. יש להוסיף פילטר לבדיקת קיום או להשתמש ב-ifempty()`,
        autoFixable: false,
      });
    }
  }

  return issues;
}
```

**Step 2: Implement JSON safety check**

`src/analyzer/checks/json-safety.ts`:
```ts
import type { ClassifiedModule, Issue } from "../../make-api/types";

const TEMPLATE_VAR_IN_BODY = /\{\{\d+\.\w+\}\}/;

export function checkJsonSafety(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification === "excluded") continue;
    if (!module.module.startsWith("http:")) continue;

    const body = module.mapper?.body || module.mapper?.jsonStringBodyContent;
    if (typeof body !== "string") continue;
    if (!TEMPLATE_VAR_IN_BODY.test(body)) continue;

    // Check if body comes from a code/json module (safe)
    // Simple heuristic: if body is just a single {{variable}}, it's likely from another module
    if (/^\{\{\d+\.[^}]+\}\}$/.test(body.trim())) continue;

    issues.push({
      moduleId: module.id,
      moduleType: module.module,
      category: "json-safety",
      severity: "warning",
      message: `מודול ${module.id} - HTTP - נתונים עם תווים מיוחדים (עברית, גרשיים) עלולים לשבור את ה-JSON. יש להשתמש במודול JSON או Code ליצירת ה-body`,
      autoFixable: false,
    });
  }

  return issues;
}
```

**Step 3: Implement handler quality check**

`src/analyzer/checks/handler-quality.ts`:
```ts
import type { ClassifiedModule, Issue } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

export function checkHandlerQuality(classified: ClassifiedModule[]): Issue[] {
  const issues: Issue[] = [];

  for (const { module, classification } of classified) {
    if (classification !== "api") continue;
    if (!Array.isArray(module.onerror) || module.onerror.length === 0) continue;

    const handlers = module.onerror;

    // Check if HTTP module has Break without WebhookRespond before it
    if (module.module.startsWith("http:")) {
      const hasBreak = handlers.some((h) => h.module === "builtin:Break");
      const hasWebhookRespond = handlers.some((h) => h.module === "gateway:WebhookRespond");
      if (hasBreak && !hasWebhookRespond) {
        const label = translateModuleType(module.module);
        issues.push({
          moduleId: module.id,
          moduleType: module.module,
          category: "handler-quality",
          severity: "info",
          message: `מודול ${module.id} - ${label} - משתמש ב-Break שעשוי להיות לא מתאים לשגיאות 400. שקול Resume עם נתונים ידניים או Ignore אם השגיאה צפויה`,
          autoFixable: false,
        });
      }
    }

    // Check for Resume without Sleep
    const hasResume = handlers.some((h) => h.module === "builtin:Resume");
    const hasSleep = handlers.some((h) => h.module === "tools:Sleep");
    if (hasResume && !hasSleep) {
      const label = translateModuleType(module.module);
      issues.push({
        moduleId: module.id,
        moduleType: module.module,
        category: "handler-quality",
        severity: "info",
        message: `מודול ${module.id} - ${label} - משתמש ב-Resume ללא המתנה. במקרה של שגיאת 429 (Rate Limit) יש להוסיף Sleep של 45-60 שניות`,
        autoFixable: false,
      });
    }
  }

  return issues;
}
```

**Step 4: Implement connection validation check**

`src/analyzer/checks/connection-validation.ts`:
```ts
import type { ClassifiedModule, Issue } from "../../make-api/types";
import { translateModuleType } from "../../utils/module-helpers";

const OPTIMATE_ORG_ID = "491016";

export function checkConnectionValidation(
  classified: ClassifiedModule[],
  organizationId?: string
): Issue[] {
  if (!organizationId || organizationId === OPTIMATE_ORG_ID) return [];

  // In a client org, check if connections belong to Optimate
  // This requires connection details which may not be in the blueprint
  // For now, this is a placeholder — full implementation needs connection inspection
  return [];
}
```

**Step 5: Implement route merging check**

`src/analyzer/checks/route-merging.ts`:
```ts
import type { ClassifiedModule, Issue, Module } from "../../make-api/types";

export function checkRouteMerging(classified: ClassifiedModule[]): Issue[] {
  // Pattern: SetVariables → Router → GetVariables in 2+ branches with same vars
  // This is complex to detect and is a low-priority optimization hint
  // Placeholder for future implementation
  return [];
}
```

**Step 6: Write tests for data validation and handler quality**

`src/analyzer/checks/data-validation.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { checkDataValidation } from "./data-validation";
import { classifyModules } from "../module-classifier";
import type { Blueprint } from "../../make-api/types";

describe("checkDataValidation", () => {
  test("flags query modules using webhook data without validation", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "powerlink:plquery", mapper: { query: "{{1.phone}}" } },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkDataValidation(classified);
    expect(issues).toHaveLength(1);
    expect(issues[0].moduleId).toBe(2);
  });

  test("does NOT flag query modules using ifempty wrapper", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        { id: 2, module: "powerlink:plquery", mapper: { query: "ifempty({{1.phone}}; 'none')" } },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkDataValidation(classified);
    expect(issues).toHaveLength(0);
  });
});
```

`src/analyzer/checks/handler-quality.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { checkHandlerQuality } from "./handler-quality";
import { classifyModules } from "../module-classifier";
import type { Blueprint } from "../../make-api/types";

describe("checkHandlerQuality", () => {
  test("flags HTTP module with Break but no WebhookRespond", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "http:ActionSendData",
          onerror: [{ id: 3, module: "builtin:Break" }],
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkHandlerQuality(classified);
    expect(issues).toHaveLength(1);
  });

  test("does NOT flag HTTP module with WebhookRespond + Break", () => {
    const blueprint: Blueprint = {
      name: "test",
      flow: [
        { id: 1, module: "gateway:CustomWebHook" },
        {
          id: 2,
          module: "http:ActionSendData",
          onerror: [
            { id: 3, module: "gateway:WebhookRespond" },
            { id: 4, module: "builtin:Break" },
          ],
        },
      ],
    } as any;
    const classified = classifyModules(blueprint);
    const issues = checkHandlerQuality(classified);
    expect(issues).toHaveLength(0);
  });
});
```

**Step 7: Run all tests**

Run: `bun test`
Expected: All PASS

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: add remaining analyzer checks (data validation, json safety, handler quality, connection, route merging)"
```

---

### Task 8: Analyzer Orchestrator

**Files:**
- Create: `src/analyzer/index.ts`
- Create: `src/analyzer/index.test.ts`

**Step 1: Write failing test**

`src/analyzer/index.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { analyze } from "./index";
import simpleBlueprint from "../../tests/fixtures/simple-blueprint.json";
import complexBlueprint from "../../tests/fixtures/complex-blueprint.json";
import type { Blueprint } from "../make-api/types";

describe("analyze", () => {
  test("returns issues for simple blueprint", () => {
    const result = analyze(simpleBlueprint as Blueprint, []);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.classified.length).toBeGreaterThan(0);
  });

  test("returns more issues for complex blueprint (no error handlers, no names)", () => {
    const result = analyze(complexBlueprint as Blueprint, []);
    const errorIssues = result.issues.filter((i) => i.category === "error-handling");
    const namingIssues = result.issues.filter((i) => i.category === "naming");
    expect(errorIssues.length).toBeGreaterThan(0);
    expect(namingIssues.length).toBeGreaterThan(0);
  });

  test("separates auto-fixable from report-only issues", () => {
    const result = analyze(complexBlueprint as Blueprint, []);
    const autoFixable = result.issues.filter((i) => i.autoFixable);
    const reportOnly = result.issues.filter((i) => !i.autoFixable);
    expect(autoFixable.length).toBeGreaterThan(0);
    // complex-blueprint has HTTP with raw body template vars → json-safety
    expect(result.issues.some((i) => i.category === "json-safety" || i.category === "scenario-naming")).toBe(true);
  });

  test("includes checklist summary", () => {
    const result = analyze(simpleBlueprint as Blueprint, []);
    expect(typeof result.checklist.hasErrorHandling).toBe("boolean");
    expect(typeof result.checklist.hasProperModuleNames).toBe("boolean");
    expect(typeof result.checklist.hasNotes).toBe("boolean");
  });
});
```

**Step 2: Implement analyzer orchestrator**

`src/analyzer/index.ts`:
```ts
import type { Blueprint, ClassifiedModule, Issue, Note } from "../make-api/types";
import { classifyModules } from "./module-classifier";
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
    hasErrorHandling: !issues.some((i) => i.category === "error-handling"),
    hasProperModuleNames: !issues.some((i) => i.category === "naming"),
    hasNotes: !issues.some((i) => i.category === "documentation"),
  };

  return { classified, issues, checklist };
}
```

**Step 3: Run all tests**

Run: `bun test`
Expected: All PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add analyzer orchestrator"
```

---

### Task 9: Fixer — Error Handler Injection & AI Content

**Files:**
- Create: `src/fixer/fixes/add-error-handler.ts`
- Create: `src/fixer/fixes/add-error-handler.test.ts`
- Create: `src/fixer/ai-content.ts`
- Create: `src/fixer/ai-content.test.ts`

**Step 1: Write failing test for error handler injection**

`src/fixer/fixes/add-error-handler.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { addErrorHandler } from "./add-error-handler";
import type { Module } from "../../make-api/types";

describe("addErrorHandler", () => {
  test("adds Break error handler to module", () => {
    const module: Module = {
      id: 5,
      module: "powerlink:plquery",
      onerror: null,
    } as any;
    const nextId = 100;
    const result = addErrorHandler(module, nextId);
    expect(result.onerror).toHaveLength(1);
    expect(result.onerror![0].id).toBe(100);
    expect(result.onerror![0].module).toBe("builtin:Break");
    expect(result.onerror![0].mapper.retry).toBe(true);
    expect(result.onerror![0].mapper.count).toBe(3);
    expect(result.onerror![0].mapper.interval).toBe(60);
  });

  test("does not modify original module", () => {
    const module: Module = { id: 5, module: "powerlink:plquery", onerror: null } as any;
    addErrorHandler(module, 100);
    expect(module.onerror).toBeNull();
  });
});
```

**Step 2: Implement error handler injection**

`src/fixer/fixes/add-error-handler.ts`:
```ts
import type { Module, ErrorHandler } from "../../make-api/types";

export function createBreakHandler(id: number): ErrorHandler {
  return {
    id,
    module: "builtin:Break",
    version: 1,
    parameters: {},
    mapper: {
      retry: true,
      count: 3,
      interval: 60,
    },
    metadata: {
      designer: { x: 0, y: 0 },
      parameters: [
        { name: "retry", type: "boolean", label: "Automatically retry" },
        { name: "count", type: "number", label: "Number of retries" },
        { name: "interval", type: "number", label: "Interval between retries" },
      ],
      expect: [
        { name: "retry", type: "boolean" },
        { name: "count", type: "integer" },
        { name: "interval", type: "integer" },
      ],
    },
  };
}

/**
 * Returns a new module object with an error handler added.
 * Does not mutate the original module.
 */
export function addErrorHandler(module: Module, nextId: number): Module {
  return {
    ...module,
    onerror: [createBreakHandler(nextId)],
  };
}
```

**Step 3: Run test**

Run: `bun test src/fixer/fixes/add-error-handler.test.ts`
Expected: PASS

**Step 4: Write failing test for AI content generator**

`src/fixer/ai-content.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { buildModuleNamePrompt, buildScenarioNamePrompt, parseAiName } from "./ai-content";

describe("buildModuleNamePrompt", () => {
  test("constructs prompt with module context", () => {
    const prompt = buildModuleNamePrompt("powerlink:plquery", { query: "{{1.phone}}" });
    expect(prompt).toContain("powerlink:plquery");
    expect(prompt).toContain("phone");
  });
});

describe("buildScenarioNamePrompt", () => {
  test("constructs prompt with blueprint context", () => {
    const prompt = buildScenarioNamePrompt("Sync", ["gateway:CustomWebHook", "powerlink:plquery", "gmail:sendEmail"]);
    expect(prompt).toContain("Sync");
    expect(prompt).toContain("powerlink");
  });
});

describe("parseAiName", () => {
  test("extracts clean name from AI response", () => {
    expect(parseAiName('"Query Contact by Phone"')).toBe("Query Contact by Phone");
    expect(parseAiName("Query Contact by Phone")).toBe("Query Contact by Phone");
    expect(parseAiName("  Query Contact by Phone  ")).toBe("Query Contact by Phone");
  });
});
```

**Step 5: Implement AI content generator**

`src/fixer/ai-content.ts`:
```ts
import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export function buildModuleNamePrompt(moduleType: string, mapper: any): string {
  const mapperSummary = mapper ? JSON.stringify(mapper).slice(0, 300) : "no mapper";
  return `You are naming a Make.com automation module. The module type is "${moduleType}" and its mapper configuration is: ${mapperSummary}

Generate a short, descriptive name (2-5 words) in English that explains what this module does in the context of the automation. Just output the name, nothing else. No quotes.

Examples:
- powerlink:plquery with phone query → "Query Contact by Phone"
- gmail:sendEmail to admin → "Notify Admin via Email"
- http:ActionSendData to webhook → "Send Data to CRM API"`;
}

export function buildScenarioNamePrompt(currentName: string, moduleTypes: string[]): string {
  return `You are renaming a Make.com automation scenario. The current name is "${currentName}" and the modules in the scenario are: ${moduleTypes.join(", ")}

Generate a descriptive scenario name that explains: what triggers it, what data flows through it, and where it goes. Use the format: "[Source/Trigger]: [Action] [Data] -> [Target]"

Just output the name, nothing else. No quotes. Keep it under 80 characters.`;
}

export function parseAiName(raw: string): string {
  return raw.replace(/^["']|["']$/g, "").trim();
}

export async function generateModuleName(moduleType: string, mapper: any): Promise<string> {
  const anthropic = getClient();
  const prompt = buildModuleNamePrompt(moduleType, mapper);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 50,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return parseAiName(text);
}

export async function generateScenarioName(
  currentName: string,
  moduleTypes: string[]
): Promise<string> {
  const anthropic = getClient();
  const prompt = buildScenarioNamePrompt(currentName, moduleTypes);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  return parseAiName(text);
}
```

**Step 6: Run tests**

Run: `bun test`
Expected: All PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: add error handler fixer and AI content generator"
```

---

### Task 10: Fixer — Module Naming & Scenario Naming Fixers

**Files:**
- Create: `src/fixer/fixes/set-module-name.ts`
- Create: `src/fixer/fixes/set-module-name.test.ts`
- Create: `src/fixer/fixes/rename-scenario.ts`

**Step 1: Write failing test**

`src/fixer/fixes/set-module-name.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { setModuleName } from "./set-module-name";
import type { Module } from "../../make-api/types";

describe("setModuleName", () => {
  test("sets name in metadata.designer.name", () => {
    const module: Module = {
      id: 5,
      module: "powerlink:plquery",
      metadata: { designer: { x: 0, y: 0 } },
    } as any;
    const result = setModuleName(module, "Query Contact by Phone");
    expect(result.metadata?.designer?.name).toBe("Query Contact by Phone");
  });

  test("creates metadata.designer if missing", () => {
    const module: Module = { id: 5, module: "powerlink:plquery" } as any;
    const result = setModuleName(module, "Query Contact");
    expect(result.metadata?.designer?.name).toBe("Query Contact");
  });

  test("does not mutate original module", () => {
    const module: Module = {
      id: 5,
      module: "powerlink:plquery",
      metadata: { designer: { x: 100, y: 200 } },
    } as any;
    const result = setModuleName(module, "New Name");
    expect(module.metadata?.designer?.name).toBeUndefined();
    expect(result.metadata?.designer?.x).toBe(100);
  });
});
```

**Step 2: Implement set module name**

`src/fixer/fixes/set-module-name.ts`:
```ts
import type { Module } from "../../make-api/types";

export function setModuleName(module: Module, name: string): Module {
  return {
    ...module,
    metadata: {
      ...module.metadata,
      designer: {
        ...module.metadata?.designer,
        name,
      },
    },
  };
}
```

**Step 3: Implement rename scenario**

`src/fixer/fixes/rename-scenario.ts`:
```ts
import type { Blueprint } from "../../make-api/types";

export function renameScenario(blueprint: Blueprint, newName: string): Blueprint {
  return {
    ...blueprint,
    name: newName,
  };
}
```

**Step 4: Run tests**

Run: `bun test`
Expected: All PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add module naming and scenario naming fixers"
```

---

### Task 11: Fixer Orchestrator

**Files:**
- Create: `src/fixer/index.ts`
- Create: `src/fixer/index.test.ts`

**Step 1: Write failing test**

`src/fixer/index.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { applyFixes } from "./index";
import { analyze } from "../analyzer/index";
import simpleBlueprint from "../../tests/fixtures/simple-blueprint.json";
import type { Blueprint } from "../make-api/types";

describe("applyFixes", () => {
  test("adds error handlers to modules missing them", async () => {
    const blueprint = simpleBlueprint as Blueprint;
    const { issues } = analyze(blueprint, []);
    const errorIssues = issues.filter(
      (i) => i.category === "error-handling" && i.autoFixable
    );

    const result = await applyFixes(blueprint, errorIssues, {
      skipAi: true, // Don't call Claude in tests
      only: ["error-handling"],
    });

    // Module 2 should now have an error handler
    const mod2 = result.fixed.flow.find((m) => m.id === 2);
    expect(mod2?.onerror).toHaveLength(1);
    expect(mod2?.onerror?.[0].module).toBe("builtin:Break");

    // Module 3 should still have its original error handler
    const mod3 = result.fixed.flow.find((m) => m.id === 3);
    expect(mod3?.onerror).toHaveLength(1);

    expect(result.changes).toHaveLength(1);
  });

  test("returns empty changes when no auto-fixable issues", async () => {
    const blueprint: Blueprint = {
      name: "Good Scenario Name: Webhook -> Fireberry -> Gmail Notification",
      flow: [
        {
          id: 1,
          module: "gateway:CustomWebHook",
          metadata: { designer: { name: "Incoming Webhook" } },
        },
        {
          id: 2,
          module: "powerlink:plquery",
          metadata: { designer: { name: "Query Contact" } },
          onerror: [{ id: 3, module: "builtin:Break", mapper: { retry: true, count: 3, interval: 60 } }],
        },
      ],
    } as any;
    const { issues } = analyze(blueprint, []);
    const autoFixable = issues.filter((i) => i.autoFixable);
    const result = await applyFixes(blueprint, autoFixable, { skipAi: true });
    expect(result.changes).toHaveLength(0);
  });
});
```

**Step 2: Implement fixer orchestrator**

`src/fixer/index.ts`:
```ts
import type { Blueprint, Issue, Module } from "../make-api/types";
import { addErrorHandler } from "./fixes/add-error-handler";
import { setModuleName } from "./fixes/set-module-name";
import { renameScenario } from "./fixes/rename-scenario";
import { generateModuleName, generateScenarioName } from "./ai-content";
import { getMaxModuleId } from "../utils/module-helpers";
import { walkModules } from "../utils/blueprint-traversal";

export interface FixChange {
  type: "error-handler" | "naming" | "scenario-naming";
  moduleId: number | null;
  description: string;
}

export interface FixResult {
  fixed: Blueprint;
  changes: FixChange[];
}

export interface FixOptions {
  skipAi?: boolean; // Skip AI calls (for testing)
  only?: string[]; // Only apply these fix categories
}

export async function applyFixes(
  blueprint: Blueprint,
  issues: Issue[],
  options: FixOptions = {}
): Promise<FixResult> {
  const { skipAi = false, only } = options;
  const changes: FixChange[] = [];

  // Deep clone the blueprint to avoid mutation
  let fixed: Blueprint = JSON.parse(JSON.stringify(blueprint));

  const shouldApply = (category: string) => !only || only.includes(category);

  // Track next available ID for error handlers
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

/**
 * Apply a transformation function to a specific module by ID within the blueprint.
 * Handles nested routes recursively. Returns a new blueprint without mutating the original.
 */
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
        routes: mod.routes.map((route) => ({
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
```

**Step 3: Run tests**

Run: `bun test`
Expected: All PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add fixer orchestrator"
```

---

### Task 12: Reporter

**Files:**
- Create: `src/reporter/index.ts`
- Create: `src/reporter/index.test.ts`

**Step 1: Write failing test**

`src/reporter/index.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { formatReport } from "./index";
import type { Issue } from "../make-api/types";
import type { FixChange } from "../fixer/index";

describe("formatReport", () => {
  test("formats auto-fixed changes", () => {
    const changes: FixChange[] = [
      { type: "error-handler", moduleId: 5, description: "Added Break error handler to module 5" },
    ];
    const report = formatReport(changes, [], { hasErrorHandling: true, hasProperModuleNames: true, hasNotes: true });
    expect(report).toContain("module 5");
  });

  test("formats report-only issues", () => {
    const issues: Issue[] = [
      {
        moduleId: 8,
        moduleType: "http:ActionSendData",
        category: "security",
        severity: "critical",
        message: "API key exposed",
        autoFixable: false,
      },
    ];
    const report = formatReport([], issues, { hasErrorHandling: true, hasProperModuleNames: true, hasNotes: true });
    expect(report).toContain("API key exposed");
  });

  test("shows clean report when no issues", () => {
    const report = formatReport([], [], { hasErrorHandling: true, hasProperModuleNames: true, hasNotes: true });
    expect(report).toContain("No issues");
  });
});
```

**Step 2: Implement reporter**

`src/reporter/index.ts`:
```ts
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

  // Header
  lines.push("╔══════════════════════════════════════╗");
  lines.push("║       Make Fixer — Report            ║");
  lines.push("╚══════════════════════════════════════╝");
  lines.push("");

  // Checklist
  lines.push("Checklist:");
  lines.push(`  ${checklist.hasErrorHandling ? "✓" : "✗"} Error Handling`);
  lines.push(`  ${checklist.hasProperModuleNames ? "✓" : "✗"} Module Names`);
  lines.push(`  ${checklist.hasNotes ? "✓" : "✗"} Documentation`);
  lines.push("");

  // Auto-fixed
  if (changes.length > 0) {
    lines.push(`Auto-fixed (${changes.length}):`);
    for (const change of changes) {
      lines.push(`  ✓ ${change.description}`);
    }
    lines.push("");
  }

  // Remaining issues
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
```

**Step 3: Run tests**

Run: `bun test`
Expected: All PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add report formatter"
```

---

### Task 13: CLI Wiring

**Files:**
- Modify: `src/cli.ts`
- Create: `src/cli.test.ts`

**Step 1: Implement the full CLI**

`src/cli.ts`:
```ts
#!/usr/bin/env bun

import { Command } from "commander";
import { MakeApiClient } from "./make-api/client";
import { analyze } from "./analyzer/index";
import { applyFixes } from "./fixer/index";
import { formatReport, formatJson } from "./reporter/index";

const program = new Command();

program
  .name("make-fixer")
  .description("Analyze and auto-fix Make.com scenario blueprints")
  .version("0.1.0");

program
  .command("analyze")
  .description("Analyze a scenario for quality issues (no changes made)")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID", parseInt)
  .option("--json", "Output as JSON instead of formatted report")
  .action(async (opts) => {
    const client = createClient();
    console.log(`Fetching scenario ${opts.scenario}...`);

    const { blueprint } = await client.fetchBlueprint(opts.scenario);
    const notes = await client.fetchNotes(opts.scenario);
    const result = analyze(blueprint, notes);

    if (opts.json) {
      console.log(formatJson([], result.issues, result.checklist));
    } else {
      console.log(formatReport([], result.issues, result.checklist));
    }
  });

program
  .command("fix")
  .description("Analyze and auto-fix a scenario")
  .requiredOption("-s, --scenario <id>", "Make.com scenario ID", parseInt)
  .option("--dry-run", "Show what would change without pushing")
  .option("--only <types>", "Only fix these issue types (comma-separated)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const client = createClient();
    console.log(`Fetching scenario ${opts.scenario}...`);

    const { blueprint } = await client.fetchBlueprint(opts.scenario);
    const notes = await client.fetchNotes(opts.scenario);

    console.log("Analyzing...");
    const result = analyze(blueprint, notes);

    const autoFixable = result.issues.filter((i) => i.autoFixable);
    const reportOnly = result.issues.filter((i) => !i.autoFixable);

    if (autoFixable.length === 0) {
      console.log("No auto-fixable issues found.");
      if (reportOnly.length > 0) {
        console.log(formatReport([], reportOnly, result.checklist));
      }
      return;
    }

    console.log(`Found ${autoFixable.length} auto-fixable issue(s). Applying fixes...`);

    const only = opts.only?.split(",");
    const { fixed, changes } = await applyFixes(blueprint, autoFixable, { only });

    console.log(formatReport(changes, reportOnly, result.checklist));

    if (opts.dryRun) {
      console.log("\n--dry-run: No changes pushed to Make.com.");
      return;
    }

    if (changes.length > 0) {
      // Confirm before pushing
      process.stdout.write(`\nPush ${changes.length} fix(es) to Make.com? [y/N] `);
      const answer = await readLine();
      if (answer.toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }

      console.log("Pushing fixed blueprint...");
      await client.pushBlueprint(opts.scenario, fixed);
      console.log("Done! Blueprint updated successfully.");
    }
  });

function createClient(): MakeApiClient {
  const token = process.env.MAKE_API_TOKEN;
  const baseUrl = process.env.MAKE_BASE_URL || "https://eu1.make.com/api/v2";

  if (!token) {
    console.error("Error: MAKE_API_TOKEN environment variable is required.");
    console.error("Set it in .env or export it: export MAKE_API_TOKEN=your_token");
    process.exit(1);
  }

  return new MakeApiClient({ token, baseUrl });
}

async function readLine(): Promise<string> {
  const buf = Buffer.alloc(256);
  const fd = 0; // stdin
  return new Promise((resolve) => {
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim());
    });
    process.stdin.resume();
  });
}

program.parse();
```

**Step 2: Write a basic integration test**

`src/cli.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { analyze } from "./analyzer/index";
import { applyFixes } from "./fixer/index";
import { formatReport } from "./reporter/index";
import simpleBlueprint from "../tests/fixtures/simple-blueprint.json";
import type { Blueprint } from "./make-api/types";

describe("CLI integration (no network)", () => {
  test("full analyze → fix → report pipeline works", async () => {
    const blueprint = simpleBlueprint as Blueprint;

    // Analyze
    const { issues, checklist } = analyze(blueprint, []);
    expect(issues.length).toBeGreaterThan(0);

    // Fix
    const autoFixable = issues.filter((i) => i.autoFixable);
    const reportOnly = issues.filter((i) => !i.autoFixable);
    const { fixed, changes } = await applyFixes(blueprint, autoFixable, { skipAi: true });

    // Module 2 should now have error handler
    const mod2 = fixed.flow.find((m) => m.id === 2);
    expect(mod2?.onerror).toHaveLength(1);

    // Report
    const report = formatReport(changes, reportOnly, checklist);
    expect(typeof report).toBe("string");
    expect(report.length).toBeGreaterThan(0);
  });
});
```

**Step 3: Run all tests**

Run: `bun test`
Expected: All PASS

**Step 4: Test CLI help**

Run: `bun src/cli.ts --help`
Expected: Shows help with `analyze` and `fix` commands

Run: `bun src/cli.ts analyze --help`
Expected: Shows `--scenario` option

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire up CLI with analyze and fix commands"
```

---

### Task 14: End-to-End Manual Test

**This task requires real API credentials.**

**Step 1: Set up .env**

```bash
cp .env.example .env
# Edit .env with real MAKE_API_TOKEN and ANTHROPIC_API_KEY
```

**Step 2: Test analyze command on a real scenario**

```bash
bun src/cli.ts analyze --scenario <YOUR_TEST_SCENARIO_ID>
```

Verify:
- [ ] Blueprint fetches successfully
- [ ] Issues are listed correctly
- [ ] Checklist shows correct results
- [ ] Output matches your existing LLM analyzer's findings

**Step 3: Test fix command with dry-run**

```bash
bun src/cli.ts fix --scenario <YOUR_TEST_SCENARIO_ID> --dry-run
```

Verify:
- [ ] Auto-fixable issues are identified
- [ ] Changes are listed but NOT pushed
- [ ] AI-generated module names make sense

**Step 4: Test fix command for real (on a non-production scenario)**

```bash
bun src/cli.ts fix --scenario <YOUR_TEST_SCENARIO_ID> --only error-handlers
```

Verify:
- [ ] Confirmation prompt appears
- [ ] After confirming, blueprint is pushed
- [ ] Open the scenario in Make.com UI — error handlers are visible
- [ ] Module IDs are preserved
- [ ] Scenario still works

**Step 5: Commit any adjustments**

```bash
git add -A
git commit -m "fix: adjustments from e2e testing"
```

---

## Summary

| Task | What | Files Created |
|------|------|---------------|
| 1 | Project scaffolding | package.json, tsconfig.json, .env.example, .gitignore |
| 2 | Types + helpers + traversal + fixtures | 7 files |
| 3 | Make.com API client | 2 files |
| 4 | Module classifier | 2 files |
| 5 | Error handling, naming, scenario naming checks | 6 files |
| 6 | Security, hardcoded, documentation checks | 6 files |
| 7 | Remaining checks | 7 files |
| 8 | Analyzer orchestrator | 2 files |
| 9 | Error handler fixer + AI content | 4 files |
| 10 | Module name + scenario name fixers | 3 files |
| 11 | Fixer orchestrator | 2 files |
| 12 | Reporter | 2 files |
| 13 | CLI wiring | 2 files |
| 14 | E2E manual test | 0 files (testing only) |

**Total: ~45 files, 14 tasks, ~14 commits**
