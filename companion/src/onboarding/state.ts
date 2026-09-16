import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { ActorsFile, NavConfig, NavigationConfig } from "../types.js";
import { CliError } from "../errors.js";
import { p } from "../paths.js";
import { resolveConfig, type RawConfig } from "../config.js";
import { globFiles } from "../util/glob.js";
import { readJson, writeJsonAtomic } from "../util/fs.js";
import { CATALOGUE, CATALOGUE_BY_KEY, presetDataSourceRules, validateAnswer, type ActorAnswer, type AnswerSource, type SmokeVerifyAnswer } from "./catalogue.js";
import { isBareOrigin, resolveApiBases } from "../derive.js";
import { uncoveredVerbs, type EndpointStats } from "./endpointStats.js";
import type { ApiBaseSpec } from "../types.js";

export type FieldStatus = "missing" | "inferred" | "confirmed";

export interface FieldState {
  required: boolean;
  status: FieldStatus;
  value?: unknown;
  source?: AnswerSource;
  evidence?: string;
  updatedAt?: string;
  /** apiBases only: what the answer resolves to right now, with the derivation trace */
  resolved?: string[];
  traces?: string[];
}

export interface OnboardingState {
  version: 1;
  status: "collecting" | "finalized";
  projectDir: string;
  createdAt: string;
  finalizedAt?: string;
  fields: Record<string, FieldState>;
  meta?: { endpointStats?: EndpointStats };
}

export const PASSWORD_PLACEHOLDER = "CHANGE_ME";

export function onboardingPath(dataDir: string): string {
  return p(dataDir, "onboarding.json");
}

export function loadOnboarding(dataDir: string): OnboardingState | null {
  const file = onboardingPath(dataDir);
  return existsSync(file) ? readJson<OnboardingState>(file) : null;
}

export function saveOnboarding(dataDir: string, state: OnboardingState): void {
  writeJsonAtomic(onboardingPath(dataDir), state);
}

function statusFor(source: AnswerSource): FieldStatus {
  return source === "code" || source === "default" ? "inferred" : "confirmed";
}

/** Create a fresh questionnaire; mechanical prefills only (name, deps-based rules, schema file globs). */
export function startOnboarding(projectDir: string, name?: string): OnboardingState {
  const state: OnboardingState = {
    version: 1,
    status: "collecting",
    projectDir,
    createdAt: new Date().toISOString(),
    fields: Object.fromEntries(CATALOGUE.map((f) => [f.key, { required: f.required, status: "missing" } satisfies FieldState])),
  };
  setAnswer(state, "name", (name ?? basename(projectDir)).toLowerCase().replace(/[^a-z0-9._-]/g, "-"), name ? "user" : "default", name ? "--name" : "project directory name, lowercased");

  const pkgFile = join(projectDir, "package.json");
  if (existsSync(pkgFile)) {
    try {
      const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(pkgFile);
      const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
      const rules = presetDataSourceRules(deps);
      if (rules.length) setAnswer(state, "dataSourceRules", rules, "default", `package.json dependencies: ${deps.filter((d) => /query|redux|zustand|pinia|vuex|swr/.test(d)).join(", ")}`);
    } catch { /* ignore unreadable package.json */ }
  }

  const schema: NavConfig["schemaSources"] = [];
  const evidence: string[] = [];
  const openapi = [...globFiles(projectDir, "**/swagger*/*.json"), ...globFiles(projectDir, "**/*swagger*.json"), ...globFiles(projectDir, "**/openapi*.json")]
    .filter((f, i, arr) => arr.indexOf(f) === i);
  if (openapi.length) {
    const dirs = [...new Set(openapi.map((f) => f.slice(projectDir.length + 1).replace(/\\/g, "/").split("/").slice(0, -1).join("/")))];
    for (const d of dirs) schema.push({ kind: "openapi", glob: d ? `${d}/*.json` : "*.json" });
    evidence.push(`${openapi.length} OpenAPI/Swagger file(s) under ${dirs.join(", ") || "."}`);
  }
  const migrations = globFiles(projectDir, "**/Migrations/*.cs");
  if (migrations.length) {
    schema.push({ kind: "efcore", glob: "**/Migrations/*.cs" });
    evidence.push(`${migrations.length} EF Core migration file(s)`);
  }
  if (schema.length) setAnswer(state, "schemaSources", schema, "default", evidence.join("; "));
  return state;
}

export function setAnswer(state: OnboardingState, key: string, value: unknown, source: AnswerSource, evidence?: string): FieldState {
  const errors = validateAnswer(key, value);
  if (errors.length) throw new CliError("E_ANSWER_INVALID", `Invalid value for ${key}: ${errors.join("; ")}`, errors);
  const def = CATALOGUE_BY_KEY[key];
  const fs: FieldState = { required: def.required, status: statusFor(source), value, source, evidence, updatedAt: new Date().toISOString() };

  if (key === "apiBases") {
    // Resolve immediately so a broken derivation fails here, not at finalize, and so the caller sees the result.
    const r = resolveApiBases(value as ApiBaseSpec[], state.projectDir);
    if (r.errors.length) throw new CliError("E_ANSWER_INVALID", `apiBases cannot be resolved against ${state.projectDir}: ${r.errors.join("; ")}`, r.errors);
    fs.resolved = r.values;
    fs.traces = r.traces;
  }
  if (key === "dataSourceRules" && Array.isArray(value) && value.length === 0 && !evidence) {
    throw new CliError("E_ANSWER_INVALID", "dataSourceRules is empty: say in --evidence why this project has no recognisable mount-time data-loading convention (and no state handed over from the previous page). An empty list means every screen is treated as deep-link safe.");
  }
  state.fields[key] = fs;
  return fs;
}

/** Mechanical warnings about answers that are valid but suspicious. Shown by answer/status/finalize. */
export function computeWarnings(state: OnboardingState): string[] {
  const warnings: string[] = [];
  const api = state.fields.apiBases;
  if (api && api.status !== "missing") {
    const r = resolveApiBases((api.value as ApiBaseSpec[]) ?? [], state.projectDir);
    for (const e of r.errors) warnings.push(`apiBases no longer resolves: ${e}`);
    r.values.forEach((v, i) => {
      if (isBareOrigin(v)) warnings.push(`apiBases[${i}] resolves to a bare origin (${v}) — no path prefix. Most apps mount their API under a prefix (an app name, /api, /v1…). Check the URL-building code and set append accordingly.`);
    });
  }
  const ro = state.fields.readOnlyPatterns;
  const stats = state.meta?.endpointStats;
  if (ro && ro.status !== "missing" && stats) {
    const patterns = (ro.value as string[]) ?? [];
    const missing = uncoveredVerbs(stats, patterns);
    if (missing.length) {
      warnings.push(`readOnlyPatterns does not cover these frequent endpoint verbs: ${missing.map((v) => `${v.verb}(${v.count}, e.g. ${v.examples[0]})`).join(", ")}. Classify each one as read (add to the pattern) or write (leave out) — do not skip them.`);
    }
  }
  const ds = state.fields.dataSourceRules;
  if (ds && ds.status !== "missing" && Array.isArray(ds.value) && ds.value.length === 0) {
    warnings.push("dataSourceRules is empty: every screen will be treated as deep-link safe. Fine only if the project really has no mount-time loading convention.");
  }
  const navi = state.fields.navigation;
  if (navi && navi.status !== "missing" && (navi.value as NavigationConfig | undefined)?.entry === "unknown") {
    warnings.push('navigation.entry is "unknown": every route not listed in data-source-map resolves to unknown, so the Agent has to observe how to enter each screen before handing over. Navigate to one non-landing route in a fresh session and answer deeplink or menu.');
  }
  if (navi && navi.status !== "missing" && navi.source === "code") {
    warnings.push("navigation.entry was answered from code. Whether a URL alone renders a screen is a runtime behaviour: verify it in the browser (--source verified) or ask the user (--source user).");
  }
  return warnings;
}

export interface StatusReport {
  status: OnboardingState["status"];
  projectDir: string;
  complete: boolean;
  warnings: string[];
  resolvedApiBases?: string[];
  missingRequired: { key: string; hint: string; question?: string; verify?: string }[];
  unconfirmed: { key: string; source?: AnswerSource; evidence?: string; verify?: string }[];
  optionalMissing: { key: string; hint: string; question?: string; default?: unknown }[];
  fields: { key: string; required: boolean; status: FieldStatus; source?: AnswerSource; value?: unknown; evidence?: string }[];
}

export function statusReport(state: OnboardingState): StatusReport {
  const missingRequired: StatusReport["missingRequired"] = [];
  const unconfirmed: StatusReport["unconfirmed"] = [];
  const optionalMissing: StatusReport["optionalMissing"] = [];
  for (const def of CATALOGUE) {
    const f = state.fields[def.key] ?? { required: def.required, status: "missing" as const };
    if (f.status === "missing") {
      if (def.required) missingRequired.push({ key: def.key, hint: def.hint, question: def.question, verify: def.verify });
      else optionalMissing.push({ key: def.key, hint: def.hint, question: def.question, default: def.default });
    } else if (f.status === "inferred") {
      unconfirmed.push({ key: def.key, source: f.source, evidence: f.evidence, verify: def.verify });
    }
  }
  return {
    status: state.status,
    projectDir: state.projectDir,
    complete: missingRequired.length === 0,
    warnings: computeWarnings(state),
    resolvedApiBases: state.fields.apiBases?.resolved,
    missingRequired,
    unconfirmed,
    optionalMissing,
    fields: CATALOGUE.map((def) => {
      const f = state.fields[def.key];
      return { key: def.key, required: def.required, status: f?.status ?? "missing", source: f?.source, value: f?.value, evidence: f?.evidence };
    }),
  };
}

export function requireComplete(state: OnboardingState): void {
  const report = statusReport(state);
  if (!report.complete) {
    throw new CliError("E_ONBOARDING_INCOMPLETE", `Onboarding is missing ${report.missingRequired.length} required field(s): ${report.missingRequired.map((m) => m.key).join(", ")}. Answer them with "nav-recorder init answer <field> ..." (see details for hints and the questions to ask the user).`, report.missingRequired);
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let cur = target;
  for (const s of segs.slice(0, -1)) {
    if (typeof cur[s] !== "object" || cur[s] === null) cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

export function toConfig(state: OnboardingState): NavConfig {
  const partial: Record<string, unknown> = {};
  for (const def of CATALOGUE) {
    if (!def.configPath) continue;
    const f = state.fields[def.key];
    const value = f && f.status !== "missing" ? f.value : def.default;
    if (value !== undefined) setPath(partial, def.configPath, value);
  }
  try {
    return resolveConfig(partial as RawConfig, state.projectDir);
  } catch (e) {
    if (e instanceof CliError) throw new CliError(e.code, "Answers do not form a valid config", e.details);
    throw e;
  }
}

export function actorsAnswer(state: OnboardingState): ActorAnswer[] {
  const f = state.fields.actors;
  return f && f.status !== "missing" ? (f.value as ActorAnswer[]) : [];
}

/** Merge answered actors into an existing actors.json without touching passwords already filled in. */
export function toActors(state: OnboardingState, existing?: ActorsFile): ActorsFile {
  const out: ActorsFile = { actors: { ...(existing?.actors ?? {}) } };
  for (const a of actorsAnswer(state)) {
    const prev = out.actors[a.role];
    out.actors[a.role] = {
      username: a.username,
      password: prev?.password && prev.username === a.username ? prev.password : PASSWORD_PLACEHOLDER,
      contextName: a.contextName ?? prev?.contextName ?? a.role,
      note: a.note ?? prev?.note,
    };
  }
  return out;
}

export function smokeAnswers(state: OnboardingState): { landingPath: string; verify: SmokeVerifyAnswer } | null {
  const lp = state.fields["smoke.landingPath"];
  const vf = state.fields["smoke.verify"];
  if (!lp || lp.status === "missing" || !vf || vf.status === "missing") return null;
  const raw = vf.value;
  const verify: SmokeVerifyAnswer = typeof raw === "string" ? { selector: raw } : (raw as SmokeVerifyAnswer);
  return { landingPath: lp.value as string, verify };
}

/** Load answers from a template directory (examples/<name>/): config + actors.example.json. */
export function answersFromTemplate(state: OnboardingState, templateDir: string): { copiedRecipes: string[] } {
  const cfgFile = join(templateDir, "config.json");
  if (!existsSync(cfgFile)) throw new CliError("E_NO_TEMPLATE", `Template config not found: ${cfgFile}`);
  const raw = readJson<RawConfig & { $schema?: string }>(cfgFile);
  delete raw.$schema;
  for (const def of CATALOGUE) {
    if (!def.configPath) continue;
    const value = def.configPath.split(".").reduce<unknown>((acc, s) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[s] : undefined), raw);
    if (value !== undefined) setAnswer(state, def.key, value, "template", `template ${basename(templateDir)}/config.json`);
  }
  const actorsFile = join(templateDir, "actors.example.json");
  if (existsSync(actorsFile)) {
    const a = readJson<ActorsFile>(actorsFile, { actors: {} });
    const list: ActorAnswer[] = Object.entries(a.actors ?? {}).map(([role, v]) => ({ role, username: v.username, contextName: v.contextName, note: v.note }));
    if (list.length) setAnswer(state, "actors", list, "template", `template ${basename(templateDir)}/actors.example.json`);
  }
  const recipes = globFiles(join(templateDir, "preconditions"), "*.json");
  return { copiedRecipes: recipes };
}
