/**
 * Minimal JSON path getter — enough for capture specs like "$.response.data.id" or
 * "$.response.items[0].code". Supports dot segments, [index] and ["quoted key"].
 */
export function jsonPathGet(root: unknown, path: string): unknown {
  let p = path.trim();
  if (p.startsWith("$")) p = p.slice(1);
  const segments: (string | number)[] = [];
  const re = /\.([A-Za-z0-9_$-]+)|\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(p)) !== null) {
    if (m.index !== consumed) throw new Error(`Unsupported JSON path syntax near "${p.slice(consumed, m.index + 1)}" in ${path}`);
    consumed = m.index + m[0].length;
    if (m[1] !== undefined) segments.push(m[1]);
    else if (m[2] !== undefined) segments.push(Number(m[2]));
    else segments.push(m[3] ?? m[4] ?? "");
  }
  if (consumed !== p.length) throw new Error(`Unsupported JSON path syntax in ${path}`);
  let cur: unknown = root;
  for (const s of segments) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[s];
  }
  return cur;
}

/** Set a value inside an object using a JSON pointer ("/a/b/0"); creates intermediate objects. */
export function jsonPointerSet(target: unknown, pointer: string, value: unknown): unknown {
  const parts = pointer.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.length === 0) return value;
  let root: unknown = target;
  if (root === null || typeof root !== "object") root = /^\d+$/.test(parts[0]) ? [] : {};
  let cur = root as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    if (next === null || typeof next !== "object") cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

export function jsonPointerGet(target: unknown, pointer: string): unknown {
  const parts = pointer.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = target;
  for (const key of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
