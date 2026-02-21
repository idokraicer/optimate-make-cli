export interface BlueprintEdit {
  path: string;
  action?: "set" | "insert" | "remove";
  value?: any;
  index?: number;
}

export interface PathResult {
  parent: any;
  key: string | number;
}

export function resolvePath(obj: any, path: string): PathResult {
  const segments = parsePath(path);
  let current = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (current == null || typeof current !== "object") {
      throw new Error(
        `Cannot traverse path "${path}" — hit non-object at segment "${seg}"`,
      );
    }
    current = current[seg];
  }

  const lastSeg = segments[segments.length - 1];
  if (current == null || typeof current !== "object") {
    throw new Error(
      `Cannot resolve path "${path}" — parent is not an object`,
    );
  }

  if (
    typeof lastSeg === "number" &&
    Array.isArray(current) &&
    (lastSeg < 0 || lastSeg >= current.length)
  ) {
    throw new Error(
      `Array index ${lastSeg} out of bounds in path "${path}" (length: ${current.length})`,
    );
  }

  return { parent: current, key: lastSeg };
}

export function parsePath(path: string): (string | number)[] {
  const segments: (string | number)[] = [];
  const regex = /([^.\[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(path)) !== null) {
    if (match[2] !== undefined) {
      segments.push(parseInt(match[2], 10));
    } else {
      segments.push(match[1]);
    }
  }

  if (segments.length === 0) {
    throw new Error(`Invalid path: "${path}"`);
  }

  return segments;
}

export function applyEdits<T>(obj: T, edits: BlueprintEdit[]): T {
  const clone: T = JSON.parse(JSON.stringify(obj));

  for (const edit of edits) {
    const action = edit.action ?? "set";

    if (action === "set") {
      if (edit.value === undefined) {
        throw new Error(`"set" action requires a value (path: "${edit.path}")`);
      }
      const { parent, key } = resolvePath(clone, edit.path);
      parent[key] = edit.value;
    } else if (action === "insert") {
      if (edit.value === undefined) {
        throw new Error(`"insert" action requires a value (path: "${edit.path}")`);
      }
      const { parent, key } = resolvePath(clone, edit.path);
      const arr = parent[key];
      if (!Array.isArray(arr)) {
        throw new Error(`"insert" target at "${edit.path}" is not an array`);
      }
      const idx = edit.index ?? arr.length;
      arr.splice(idx, 0, edit.value);
    } else if (action === "remove") {
      const { parent, key } = resolvePath(clone, edit.path);
      if (Array.isArray(parent) && typeof key === "number") {
        parent.splice(key, 1);
      } else {
        delete parent[key];
      }
    } else {
      throw new Error(`Unknown action: "${action}"`);
    }
  }

  return clone;
}
