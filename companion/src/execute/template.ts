import { createHash, randomUUID } from "node:crypto";

/**
 * Expands {{var}} and {{fn(var)}} placeholders in strings (recursively through objects/arrays).
 * Supported functions: md5, sha1, sha256, base64, uuid(), now(). Used for api-login body templates.
 */
export function expandTemplate<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === "string") return expandString(value, vars) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => expandTemplate(v, vars)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandTemplate(v, vars);
    return out as T;
  }
  return value;
}

function expandString(s: string, vars: Record<string, string>): string {
  return s.replace(/\{\{\s*([A-Za-z0-9_]+)\s*(?:\(\s*([A-Za-z0-9_]*)\s*\))?\s*\}\}/g, (_m, name: string, arg: string | undefined) => {
    if (arg === undefined) {
      if (!(name in vars)) throw new Error(`Template variable not provided: ${name}`);
      return vars[name];
    }
    const input = arg === "" ? "" : vars[arg];
    if (arg !== "" && input === undefined) throw new Error(`Template variable not provided: ${arg}`);
    switch (name) {
      case "md5": return createHash("md5").update(input).digest("hex");
      case "sha1": return createHash("sha1").update(input).digest("hex");
      case "sha256": return createHash("sha256").update(input).digest("hex");
      case "base64": return Buffer.from(input, "utf8").toString("base64");
      case "uuid": return randomUUID();
      case "now": return new Date().toISOString();
      default: throw new Error(`Unknown template function: ${name}`);
    }
  });
}
