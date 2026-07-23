import type { ClassifiedApiError } from "../make-api/api-error";

export interface CommandMetadata {
  cliVersion: string;
  source: string;
  verifiedAt: string;
  [key: string]: unknown;
}

export type CommandEnvelope<T> =
  | {
      ok: true;
      command: string;
      data: T;
      meta: CommandMetadata;
    }
  | {
      ok: false;
      command: string;
      error: ClassifiedApiError;
    };

export function successEnvelope<T>(
  command: string,
  data: T,
  meta: CommandMetadata,
): CommandEnvelope<T> {
  return { ok: true, command, data, meta };
}

export function failureEnvelope(command: string, error: ClassifiedApiError): CommandEnvelope<never> {
  return { ok: false, command, error };
}

export function exitCodeFor(error: ClassifiedApiError): 1 | 2 | 3 {
  switch (error.code) {
    case "AUTH_INVALID":
    case "SCOPE_MISSING":
    case "PLAN_RESTRICTED":
    case "NOT_SUPPORTED":
      return 2;
    case "RATE_LIMITED":
    case "TRANSIENT":
      return 3;
    default:
      return 1;
  }
}
