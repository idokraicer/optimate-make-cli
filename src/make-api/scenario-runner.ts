export interface ScenarioInterface {
  input?: ScenarioInputField[];
  output?: ScenarioOutputField[] | null;
}

export interface ScenarioInputField {
  name: string;
  label?: string;
  type: string;
  required?: boolean;
  specification?: unknown;
}

export type ScenarioOutputField = ScenarioInputField;

export type InputValidationResult =
  | { valid: true; normalized: Record<string, unknown> }
  | { valid: false; issues: Array<{ path: string; message: string }> };

type ValidationIssue = { path: string; message: string };

export function validateScenarioInput(
  spec: ScenarioInterface,
  data: unknown,
): InputValidationResult {
  if (!isRecord(data)) {
    return { valid: false, issues: [{ path: "$", message: "Expected an object." }] };
  }

  const issues: ValidationIssue[] = [];
  const normalized = validateObject(spec.input ?? [], data, "", issues);
  return issues.length === 0
    ? { valid: true, normalized }
    : { valid: false, issues };
}

function validateObject(
  fields: ScenarioInputField[],
  value: Record<string, unknown>,
  prefix: string,
  issues: ValidationIssue[],
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  const known = new Set(fields.map((field) => field.name));

  for (const field of fields) {
    const path = joinPath(prefix, field.name);
    if (!(field.name in value) || value[field.name] === undefined || value[field.name] === null) {
      if (field.required) issues.push({ path, message: "Required input is missing." });
      continue;
    }
    const normalizedValue = validateValue(field, value[field.name], path, issues);
    if (normalizedValue !== INVALID) normalized[field.name] = normalizedValue;
  }
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      issues.push({ path: joinPath(prefix, key), message: "Unknown input field." });
    }
  }
  return normalized;
}

const INVALID = Symbol("invalid");

function validateValue(
  field: ScenarioInputField,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): unknown | typeof INVALID {
  const type = field.type.toLowerCase();
  if (["text", "string", "email", "url", "date", "time"].includes(type)) {
    if (typeof value !== "string") {
      issues.push({ path, message: "Expected text." });
      return INVALID;
    }
    return value;
  }
  if (["number", "integer", "uinteger"].includes(type)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({ path, message: "Expected number." });
      return INVALID;
    }
    return value;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") {
      issues.push({ path, message: "Expected boolean." });
      return INVALID;
    }
    return value;
  }
  if (type === "collection") {
    if (!isRecord(value)) {
      issues.push({ path, message: "Expected an object." });
      return INVALID;
    }
    return validateObject(specificationFields(field.specification), value, path, issues);
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      issues.push({ path, message: "Expected an array." });
      return INVALID;
    }
    const itemField = arrayItemField(field.specification);
    if (!itemField) return value;
    return value.map((item, index) =>
      validateValue(itemField, item, `${path}[${index}]`, issues)
    ).filter((item) => item !== INVALID);
  }

  // Make can introduce app-specific input types. Preserve their JSON value
  // while still enforcing the interface's field names and required markers.
  return value;
}

function specificationFields(value: unknown): ScenarioInputField[] {
  if (Array.isArray(value)) return value.filter(isInputField);
  if (isRecord(value) && Array.isArray(value.specification)) {
    return value.specification.filter(isInputField);
  }
  return [];
}

function arrayItemField(value: unknown): ScenarioInputField | null {
  if (isRecord(value) && typeof value.type === "string") {
    return {
      name: "item",
      type: value.type,
      required: Boolean(value.required),
      specification: value.specification,
    };
  }
  if (Array.isArray(value)) {
    return { name: "item", type: "collection", specification: value };
  }
  return null;
}

function isInputField(value: unknown): value is ScenarioInputField {
  return isRecord(value) && typeof value.name === "string" && typeof value.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function joinPath(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

export function parseRunTimeout(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)$/i);
  if (!match) throw new Error("--timeout must be a positive duration such as 30s or 2m.");
  const amount = Number(match[1]);
  const multiplier = match[2].toLowerCase() === "ms"
    ? 1
    : match[2].toLowerCase() === "s" ? 1_000 : 60_000;
  const milliseconds = amount * multiplier;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error("--timeout must be a positive duration such as 30s or 2m.");
  }
  return Math.ceil(milliseconds);
}

export type ExecutionDetails = {
  status: "RUNNING" | "SUCCESS" | "WARNING" | "ERROR";
  outputs?: Record<string, unknown>;
  error?: unknown;
};

export type PollResult = ExecutionDetails | {
  status: "RUNNING";
  code: "RUN_STILL_RUNNING";
  executionId: string;
};

export async function pollScenarioExecution(options: {
  scenarioId: number;
  executionId: string;
  timeoutMs: number;
  fetchExecutionDetails: (
    scenarioId: number,
    executionId: string,
  ) => Promise<ExecutionDetails>;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}): Promise<PollResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const deadline = now() + options.timeoutMs;
  let delay = 250;

  while (true) {
    throwIfAborted(options.signal);
    if (now() >= deadline) {
      return {
        status: "RUNNING",
        code: "RUN_STILL_RUNNING",
        executionId: options.executionId,
      };
    }
    const details = await options.fetchExecutionDetails(
      options.scenarioId,
      options.executionId,
    );
    if (details.status !== "RUNNING") return details;
    const remaining = deadline - now();
    if (remaining <= 0) {
      return {
        status: "RUNNING",
        code: "RUN_STILL_RUNNING",
        executionId: options.executionId,
      };
    }
    await sleep(Math.min(delay, remaining, 5_000), options.signal);
    delay = Math.min(delay * 2, 5_000);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("The scenario run wait was cancelled.", "AbortError");
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The scenario run wait was cancelled.", "AbortError"));
    }, { once: true });
  });
}
