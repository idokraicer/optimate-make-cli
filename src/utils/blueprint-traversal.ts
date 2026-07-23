import type { Module } from "../make-api/types";

export type ModuleContainer = "flow" | "route" | "branch" | "onerror";

export interface WalkedModule {
  module: Module;
  path: string;
  depth: number;
  parentModuleId: number | null;
  container: ModuleContainer;
}

/**
 * Recursively walk all modules in a blueprint flow, including nested routes,
 * branches, and error handlers.
 * Returns a flat list with path information for each module.
 */
export function walkModules(
  flow: Module[],
  options: { includeErrorHandlers?: boolean } = {},
): WalkedModule[] {
  const result: WalkedModule[] = [];
  const includeErrorHandlers = options.includeErrorHandlers ?? true;

  const visitModule = (
    module: Module,
    path: string,
    depth: number,
    parentModuleId: number | null,
    container: ModuleContainer,
  ): void => {
    result.push({ module, path, depth, parentModuleId, container });

    const visitChildren = (
      routes: Module["routes"],
      property: "routes" | "branches",
      childContainer: "route" | "branch",
    ): void => {
      if (!Array.isArray(routes)) return;

      for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
        const route = routes[routeIndex];
        if (Array.isArray(route.flow)) {
          for (let moduleIndex = 0; moduleIndex < route.flow.length; moduleIndex++) {
            visitModule(
              route.flow[moduleIndex],
              `${path}.${property}[${routeIndex}].flow[${moduleIndex}]`,
              depth + 1,
              module.id,
              childContainer,
            );
          }
        }
      }
    };

    visitChildren(module.routes, "routes", "route");
    visitChildren(module.branches, "branches", "branch");

    if (includeErrorHandlers && Array.isArray(module.onerror)) {
      for (let handlerIndex = 0; handlerIndex < module.onerror.length; handlerIndex++) {
        visitModule(
          module.onerror[handlerIndex],
          `${path}.onerror[${handlerIndex}]`,
          depth + 1,
          module.id,
          "onerror",
        );
      }
    }
  };

  for (let i = 0; i < flow.length; i++) {
    visitModule(flow[i], `flow[${i}]`, 0, null, "flow");
  }

  return result;
}

export function findWalkedModulesById(flow: Module[], id: number): WalkedModule[] {
  return walkModules(flow).filter((entry) => entry.module.id === id);
}
