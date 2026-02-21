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
