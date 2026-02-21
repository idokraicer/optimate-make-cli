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
