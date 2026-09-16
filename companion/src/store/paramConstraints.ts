import { p } from "../paths.js";
import { readJson, writeJsonAtomic, writeText } from "../util/fs.js";

export interface ParamConstraint {
  /** true = must be unique (use faker); false = safe to repeat; null = unknown */
  unique: boolean | null;
  source: "code" | "runtime-probe" | "none";
  location?: string;
  observedError?: string;
  note?: string;
  updatedAt: string;
}

export interface ParamConstraintsFile {
  /** "METHOD url" → param key → constraint */
  entries: Record<string, Record<string, ParamConstraint>>;
}

export function callKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

export function loadParamConstraints(dataDir: string): ParamConstraintsFile {
  const f = readJson<Partial<ParamConstraintsFile>>(p(dataDir, "param-constraints.json"), {});
  return { entries: f.entries ?? {} };
}

export function saveParamConstraints(dataDir: string, file: ParamConstraintsFile): void {
  writeJsonAtomic(p(dataDir, "param-constraints.json"), file);
  writeText(p(dataDir, "param-constraints.md"), renderParamConstraints(file));
}

export function upsertParamConstraint(dataDir: string, method: string, url: string, param: string, c: Omit<ParamConstraint, "updatedAt">): ParamConstraintsFile {
  const file = loadParamConstraints(dataDir);
  const key = callKey(method, url);
  file.entries[key] ??= {};
  const existing = file.entries[key][param];
  // Never let a runtime probe overwrite a code-sourced verdict.
  if (existing && existing.source === "code" && c.source !== "code") return file;
  file.entries[key][param] = { ...c, updatedAt: new Date().toISOString() };
  saveParamConstraints(dataDir, file);
  return file;
}

export function renderParamConstraints(file: ParamConstraintsFile): string {
  const lines = [
    "# param-constraints",
    "",
    "Per-API parameter uniqueness findings. `source: code` was read from a schema and can be trusted;",
    "`source: runtime-probe` was inferred from the error returned when the same request was sent twice —",
    "treat it as a hint and re-check when something looks off.",
    "",
  ];
  const keys = Object.keys(file.entries).sort();
  if (!keys.length) lines.push("_(empty)_");
  for (const key of keys) {
    lines.push(`## \`${key}\``, "");
    lines.push("| param | unique | source | evidence |", "|---|---|---|---|");
    for (const [param, c] of Object.entries(file.entries[key])) {
      const evidence = c.location ? `\`${c.location}\`` : c.observedError ? c.observedError.replace(/\|/g, "\\|").slice(0, 200) : c.note ?? "";
      lines.push(`| \`${param}\` | ${c.unique === null ? "?" : c.unique ? "yes" : "no"} | ${c.source} | ${evidence} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
