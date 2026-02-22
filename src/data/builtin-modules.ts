import type { AppModule } from "../make-api/types";

/**
 * Hardcoded catalog of builtin/utility modules that Make.com doesn't expose
 * through its `/modules-with-credentials` API endpoint.
 */
export const BUILTIN_MODULES: Record<string, AppModule[]> = {
  builtin: [
    { id: "builtin:BasicFeeder", name: "BasicFeeder", label: "Iterator", type: "feeder", hook: false },
    { id: "builtin:BasicAggregator", name: "BasicAggregator", label: "Array Aggregator", type: "aggregator", hook: false },
    { id: "builtin:BasicRouter", name: "BasicRouter", label: "Router", type: "router", hook: false },
    { id: "builtin:BasicRepeater", name: "BasicRepeater", label: "Repeater", type: "repeater", hook: false },
    { id: "builtin:Break", name: "Break", label: "Break", type: "error_handler", hook: false },
    { id: "builtin:Resume", name: "Resume", label: "Resume", type: "error_handler", hook: false },
    { id: "builtin:Ignore", name: "Ignore", label: "Ignore", type: "error_handler", hook: false },
    { id: "builtin:Commit", name: "Commit", label: "Commit", type: "error_handler", hook: false },
    { id: "builtin:Rollback", name: "Rollback", label: "Rollback", type: "error_handler", hook: false },
  ],

  gateway: [
    { id: "gateway:CustomWebHook", name: "CustomWebHook", label: "Custom Webhook", type: "trigger", hook: true },
    { id: "gateway:WebhookRespond", name: "WebhookRespond", label: "Webhook Response", type: "responder", hook: false },
  ],

  json: [
    { id: "json:ParseJSON", name: "ParseJSON", label: "Parse JSON", type: "transformer", hook: false },
    { id: "json:CreateJSON", name: "CreateJSON", label: "Create JSON", type: "transformer", hook: false },
    { id: "json:TransformToJSON", name: "TransformToJSON", label: "Transform to JSON", type: "transformer", hook: false },
    { id: "json:AggregateToJSON", name: "AggregateToJSON", label: "Aggregate to JSON", type: "aggregator", hook: false },
  ],

  util: [
    { id: "util:FunctionSleep", name: "FunctionSleep", label: "Sleep", type: "action", hook: false },
    { id: "util:SetVariables", name: "SetVariables", label: "Set Multiple Variables", type: "action", hook: false },
    { id: "util:SetVariable2", name: "SetVariable2", label: "Set Variable", type: "action", hook: false },
    { id: "util:GetVariables", name: "GetVariables", label: "Get Multiple Variables", type: "action", hook: false },
    { id: "util:GetVariable2", name: "GetVariable2", label: "Get Variable", type: "action", hook: false },
    { id: "util:FunctionIncrement", name: "FunctionIncrement", label: "Increment Function", type: "action", hook: false },
    { id: "util:FunctionAggregator2", name: "FunctionAggregator2", label: "Numeric Aggregator", type: "aggregator", hook: false },
    { id: "util:AggregateAggregator", name: "AggregateAggregator", label: "Table Aggregator", type: "aggregator", hook: false },
    { id: "util:TextAggregator", name: "TextAggregator", label: "Text Aggregator", type: "aggregator", hook: false },
    { id: "util:Switcher", name: "Switcher", label: "Switch", type: "transformer", hook: false },
  ],

  code: [
    { id: "code:ExecuteCode", name: "ExecuteCode", label: "Execute Custom Code", type: "action", hook: false },
  ],

  phonenumber: [
    { id: "phonenumber:TransformerParseNumber", name: "TransformerParseNumber", label: "Parse Phone Number", type: "transformer", hook: false },
  ],

  "scenario-service": [
    { id: "scenario-service:NameExecution", name: "NameExecution", label: "Name Execution", type: "action", hook: false },
  ],

  placeholder: [
    { id: "placeholder:Placeholder", name: "Placeholder", label: "Placeholder", type: "placeholder", hook: false },
  ],
};

/**
 * Module templates: mapper structures and metadata.expect for creating builtin modules.
 * Keyed by full module ID (e.g. "builtin:BasicRepeater").
 */
export interface ModuleTemplate {
  /** Example mapper object — required fields for the module to work */
  mapper: Record<string, unknown>;
  /** Parameters object (connection-level config, not user data) */
  parameters?: Record<string, unknown>;
  /** metadata.expect array — field schema shown in Make.com UI */
  expect?: Record<string, unknown>[];
}

export const BUILTIN_MODULE_TEMPLATES: Record<string, ModuleTemplate> = {
  // --- builtin ---

  "builtin:BasicFeeder": {
    mapper: { array: "{{someArray}}" },
    expect: [
      { name: "array", type: "array", label: "Array", mode: "edit", spec: [] },
    ],
  },

  "builtin:BasicAggregator": {
    // parameters.feeder must reference the source module ID (number)
    mapper: {},
    parameters: { feeder: 0 },
  },

  "builtin:BasicRouter": {
    // Router has no mapper — uses routes[] array instead
    mapper: null as any,
  },

  "builtin:BasicRepeater": {
    mapper: { start: "1", repeats: "5", step: "1" },
    expect: [
      { name: "start", type: "number", label: "Initial value", required: true },
      { name: "repeats", type: "number", label: "Repeats", validate: { min: 0, max: 10000 }, required: true },
      { name: "step", type: "number", label: "Step", required: true },
    ],
  },

  "builtin:Break": {
    mapper: { retry: true, count: "3", interval: "15" },
    expect: [
      { name: "retry", type: "boolean", label: "Automatically complete execution", required: true },
      { name: "count", type: "uinteger", label: "Number of attempts", validate: { min: 1, max: 10000 }, required: true },
      { name: "interval", type: "uinteger", label: "Interval between attempts", validate: { min: 1, max: 44640 }, required: true },
    ],
  },

  "builtin:Resume": {
    // mapper mirrors the output fields of the erroring module
    mapper: {},
  },

  "builtin:Ignore": {
    mapper: {},
  },

  "builtin:Commit": {
    mapper: {},
  },

  "builtin:Rollback": {
    mapper: {},
  },

  // --- gateway ---

  "gateway:CustomWebHook": {
    // parameters.hook is the webhook ID (number), maxResults is optional
    mapper: {},
    parameters: { hook: 0, maxResults: 1 },
  },

  "gateway:WebhookRespond": {
    mapper: { status: "200", body: "", headers: [] },
    expect: [
      { name: "status", type: "uinteger", label: "Status", validate: { min: 100 }, required: true },
      { name: "body", type: "any", label: "Body" },
      { name: "headers", type: "array", label: "Custom headers", validate: { maxItems: 16 }, spec: [
        { name: "key", label: "Key", type: "text", required: true, validate: { max: 256 } },
        { name: "value", label: "Value", type: "text", required: true, validate: { max: 4096 } },
      ] },
    ],
  },

  // --- json ---

  "json:ParseJSON": {
    mapper: { json: "" },
    parameters: { type: "" },
    expect: [
      { name: "json", type: "text", label: "JSON string", required: true },
    ],
  },

  "json:CreateJSON": {
    // mapper fields depend on the selected data structure (parameters.type = UDT ID)
    mapper: {},
    parameters: { type: 0, space: "" },
  },

  "json:TransformToJSON": {
    mapper: { object: "" },
    parameters: { space: "" },
    expect: [
      { name: "object", type: "any", label: "Object" },
    ],
  },

  "json:AggregateToJSON": {
    // parameters.feeder = source module ID, parameters.type = UDT ID
    mapper: { item: "" },
    parameters: { type: 0, space: "", feeder: 0 },
    expect: [
      { name: "item", type: "text", label: null as any },
    ],
  },

  // --- util ---

  "util:FunctionSleep": {
    mapper: { duration: "1" },
    expect: [
      { name: "duration", type: "uinteger", label: "Delay", validate: { min: 1, max: 300 }, required: true },
    ],
  },

  "util:SetVariables": {
    // variables: array of { name, value } pairs; scope: "roundtrip" (one cycle) or "execution"
    mapper: { variables: [{ name: "", value: "" }], scope: "roundtrip" },
    expect: [
      { name: "variables", type: "array", label: "Variables", spec: [
        { name: "name", type: "text", label: "Variable name", required: true },
        { name: "value", type: "any", label: "Variable value" },
      ] },
      { name: "scope", type: "select", label: "Variable lifetime", required: true, validate: { enum: ["roundtrip", "execution"] } },
    ],
  },

  "util:SetVariable2": {
    mapper: { name: "", scope: "roundtrip", value: "" },
    expect: [
      { name: "name", type: "text", label: "Variable name", required: true },
      { name: "scope", type: "select", label: "Variable lifetime", required: true, validate: { enum: ["roundtrip", "execution"] } },
      { name: "value", type: "any", label: "Variable value" },
    ],
  },

  "util:GetVariables": {
    // variables: array of plain variable name strings to retrieve
    mapper: { variables: ["variableName"] },
    expect: [
      { name: "variables", type: "array", label: "Variables", spec: {
        name: "value", type: "text", label: "Variable name", required: true,
      } },
    ],
  },

  "util:GetVariable2": {
    mapper: { name: "" },
    expect: [
      { name: "name", type: "text", label: "Variable name", required: true },
    ],
  },

  "util:FunctionIncrement": {
    // parameters.reset: "run" (after one cycle), "execution", or "scenario"
    mapper: {},
    parameters: { reset: "run" },
  },

  "util:FunctionAggregator2": {
    // parameters.fn: "avg"|"sum"|"count"|"max"|"min"; parameters.feeder: source module ID
    mapper: { value: "" },
    parameters: { fn: "sum", feeder: 0 },
    expect: [
      { name: "value", type: "number", label: "Value" },
    ],
  },

  "util:AggregateAggregator": {
    // parameters.feeder: source module ID
    mapper: {},
    parameters: { columnSeparator: "", rowSeparator: "", feeder: 0 },
  },

  "util:TextAggregator": {
    // parameters.feeder: source module ID
    mapper: { value: "" },
    parameters: { rowSeparator: "", feeder: 0 },
    expect: [
      { name: "value", type: "text", label: "Text" },
    ],
  },

  "util:Switcher": {
    mapper: { input: "", useRegExpMatch: false, casesTable: [{ pattern: "", output: "" }], elseOutput: "" },
    expect: [
      { name: "input", type: "text", label: "Input" },
      { name: "useRegExpMatch", type: "boolean", label: "Use regular expressions to match", required: true },
      { name: "casesTable", type: "array", label: "Cases", required: true, spec: [
        { name: "pattern", type: "text", label: "Pattern" },
        { name: "output", type: "any", label: "Output" },
      ] },
      { name: "elseOutput", type: "any", label: "Else" },
    ],
  },

  // --- code ---

  "code:ExecuteCode": {
    mapper: {
      language: "javascript",
      input: [],
      dependencies: [],
      inputFormat: "editor",
      codeEditorJavascript: "",
    },
    expect: [
      { name: "language", type: "select", label: "Language", required: true, validate: { enum: ["javascript", "python"] } },
      { name: "input", type: "array", label: "Input", spec: { type: "collection", label: "Variable", spec: [
        { name: "name", type: "text", required: true, validate: { pattern: "^[a-zA-Z0-9_]{1,32}$", min: 1, max: 32 }, label: "Name" },
        { name: "value", type: "any", label: "Value" },
      ], name: "value" } },
      { name: "dependencies", type: "array", label: "Additional dependencies (Enterprise plans only)" },
      { name: "inputFormat", type: "select", label: "Input format", required: true, validate: { enum: ["editor", "string"] } },
      { name: "codeEditorJavascript", type: "editor", label: "Code", required: true },
    ],
  },

  // --- phonenumber ---

  "phonenumber:TransformerParseNumber": {
    mapper: { number: "", defaultCountry: "US" },
    expect: [
      { name: "number", type: "text", label: "Phone number", required: true },
      { name: "defaultCountry", type: "select", label: "Default country for parsing", required: true },
    ],
  },

  // --- scenario-service ---

  "scenario-service:NameExecution": {
    mapper: { executionName: "" },
    expect: [
      { name: "executionName", type: "text", label: "Run name", required: true },
    ],
  },
};
