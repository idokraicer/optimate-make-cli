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
