import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ApiBaseSpec, DerivedApiBase } from "./types.js";
import { readJson, readText } from "./util/fs.js";

export function isDerivedApiBase(v: unknown): v is DerivedApiBase {
  return !!v && typeof v === "object" && (v as DerivedApiBase).derive === "json";
}

/** Shape-only validation (no file access) — used for onboarding answers and config files. */
export function validateApiBaseSpec(spec: unknown, index: number): string[] {
  if (typeof spec === "string") {
    const errors: string[] = [];
    try { new URL(spec); } catch { errors.push(`apiBases[${index}] is not a valid URL: ${spec}`); }
    if (!spec.endsWith("/")) errors.push(`apiBases[${index}] must end with "/": ${spec}`);
    return errors;
  }
  if (!isDerivedApiBase(spec)) return [`apiBases[${index}] must be a URL string or {derive:"json", file, path, append?, pathFrom?}`];
  const errors: string[] = [];
  if (!spec.file) errors.push(`apiBases[${index}].file is required`);
  if (!spec.path) errors.push(`apiBases[${index}].path is required`);
  if (spec.pathFrom) {
    if (!spec.pathFrom.file || !spec.pathFrom.regex || !spec.pathFrom.template) errors.push(`apiBases[${index}].pathFrom needs file, regex and template`);
    else { try { new RegExp(spec.pathFrom.regex); } catch { errors.push(`apiBases[${index}].pathFrom.regex is not a valid regex`); } }
  }
  return errors;
}

function walk(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, s) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[s] : undefined), obj);
}

export interface ResolvedApiBase {
  value?: string;
  error?: string;
  /** human-readable trace of how the value was derived */
  trace?: string;
}

export function resolveApiBase(spec: ApiBaseSpec, projectDir: string): ResolvedApiBase {
  if (typeof spec === "string") return { value: spec };
  let path = spec.path;
  const trace: string[] = [];
  if (spec.pathFrom) {
    const src = join(projectDir, spec.pathFrom.file);
    if (!existsSync(src)) return { error: `apiBases: pathFrom.file not found: ${src}` };
    const m = new RegExp(spec.pathFrom.regex).exec(readText(src));
    if (!m) return { error: `apiBases: /${spec.pathFrom.regex}/ did not match anything in ${spec.pathFrom.file}` };
    path = spec.pathFrom.template.replace(/\$(\d)/g, (_s, i: string) => m[Number(i)] ?? "");
    trace.push(`${spec.pathFrom.file} matched "${m[0]}" → ${path}`);
  }
  const jsonFile = join(projectDir, spec.file);
  if (!existsSync(jsonFile)) return { error: `apiBases: file not found: ${jsonFile}` };
  let raw: unknown;
  try { raw = readJson<unknown>(jsonFile); } catch (e) { return { error: `apiBases: ${(e as Error).message}` }; }
  const v = walk(raw, path);
  if (typeof v !== "string" || !v) return { error: `apiBases: ${spec.file} has no string at ${path}` };
  const base = v.replace(/\/+$/, "");
  const append = (spec.append ?? "/").replace(/^\/*/, "/");
  const value = (base + append).replace(/\/*$/, "/");
  trace.push(`${spec.file} ${path} = ${v}`);
  return { value, trace: trace.join("; ") };
}

/** True when the base has no path prefix at all (e.g. "https://host/") — almost always a mistake. */
export function isBareOrigin(url: string): boolean {
  try { return new URL(url).pathname === "/"; } catch { return false; }
}

export function resolveApiBases(specs: ApiBaseSpec[], projectDir: string): { values: string[]; errors: string[]; traces: string[] } {
  const values: string[] = [];
  const errors: string[] = [];
  const traces: string[] = [];
  specs.forEach((s, i) => {
    const shape = validateApiBaseSpec(s, i);
    if (shape.length) { errors.push(...shape); return; }
    const r = resolveApiBase(s, projectDir);
    if (r.error) errors.push(r.error);
    else if (r.value) { values.push(r.value); if (r.trace) traces.push(r.trace); }
  });
  return { values, errors, traces };
}
