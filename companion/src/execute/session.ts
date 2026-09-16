import { existsSync } from "node:fs";
import type { Recipe, ApiStep, RecipeShape, RecipeStep, UiAction } from "../recipe.js";
import type { ActorsFile, NavConfig, LoginApi, LoginUi } from "../types.js";
import { isApiStep, recipeShape } from "../recipe.js";
import { effectiveEntry, loadDataSourceMap, type EffectiveEntry } from "../store/dataSourceMap.js";
import { CliError } from "../errors.js";
import { p } from "../paths.js";
import { readJson } from "../util/fs.js";
import { loadRecipe } from "../store/recipes.js";
import {
  cleanupSessions, deleteSession, loadSession, newSessionId, saveSession,
  type SessionFile, type StorageSnapshot, type PendingStep, type ProbeResult,
} from "../store/sessions.js";
import { upsertParamConstraint } from "../store/paramConstraints.js";
import { resolveApiStep, type ResolvedStep } from "./resolver.js";
import { expandTemplate } from "./template.js";
import { jsonPathGet } from "./jsonpath.js";
import { apiUrl, appUrl } from "./urls.js";

const DUPLICATE_SIGNAL = /409|duplicate|already exists|already exist|unique|重複|已存在|已經存在/i;

// ---------- public payload shapes ----------

export interface LoginUiAction {
  type: "login-ui";
  url: string;
  fields: { username: string; password: string };
  submit: string;
  successCheck?: LoginUi["successCheck"];
  credentials: { username: string; password: string };
}

export interface LoginApiAction {
  type: "login-api";
  method: string;
  url: string;
  body: Record<string, unknown>;
  storageSeed?: LoginApi["storageSeed"];
  appUrl: string;
}

export interface EnsureContext {
  contextName: string;
  actor: string;
  login: LoginUiAction | LoginApiAction;
  storageReset: NavConfig["storageReset"];
  reportStorageSnapshot: boolean;
}

export interface FetchAction {
  type: "fetch";
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type UiActionAbs = UiAction & { gotoUrl?: string; url?: string };

export interface NextInstruction {
  sessionId: string;
  stepIndex: number;
  stepId: string;
  totalSteps: number;
  attempt: number;
  repeat: boolean;
  probeRound?: 1 | 2;
  actor: string;
  contextName: string;
  kind: "api" | "ui";
  ensureContext?: EnsureContext;
  switchTab?: { from: string; to: string; reseedLocalStorage?: Record<string, string>; relogin: boolean };
  auth: NavConfig["auth"];
  action: FetchAction | UiActionAbs;
  captureSpec?: Record<string, string>;
  expect?: ApiStep["expect"];
  note?: string;
  warnings: string[];
}

export interface DonePayload {
  next: "done";
  sessionId: string;
  finalNavigation: string;
  /** whether finalNavigation may be opened by URL or must be walked to through the app's menus */
  finalNavigationEntry: EffectiveEntry;
  finalContext: string;
  shape: RecipeShape;
  existingDataRefs?: Recipe["existingDataRefs"];
  targetHint?: Recipe["targetHint"];
  verify?: Recipe["verify"];
  captured: Record<string, unknown>;
  probeReport?: ProbeResult[];
  contexts: string[];
}

export interface ReportInput {
  status: "ok" | "error";
  message?: string;
  httpStatus?: number;
  response?: unknown;
  captured?: Record<string, unknown>;
  storageSnapshot?: StorageSnapshot;
}

export type ReportResult =
  | { next: "continue"; sessionId: string; stepIndex: number; retry: boolean; attempt?: number; captured: Record<string, unknown> }
  | { next: "halt"; sessionId: string; reason: string; failures: Record<string, number>; lastError?: string; stepIndex: number }
  | DonePayload;

// ---------- helpers ----------

function loadActors(dataDir: string): ActorsFile {
  const file = p(dataDir, "actors.json");
  if (!existsSync(file)) throw new CliError("E_NO_ACTORS", `${file} missing. Create it with the test-account credentials.`);
  const a = readJson<ActorsFile>(file);
  return { actors: a.actors ?? {} };
}

function enabledSteps(recipe: Recipe): { index: number; step: RecipeStep }[] {
  return recipe.steps.map((step, index) => ({ index, step })).filter(({ step }) => !step.disabled);
}

function nextEnabledIndex(recipe: Recipe, from: number): number {
  for (let i = from; i < recipe.steps.length; i++) if (!recipe.steps[i].disabled) return i;
  return -1;
}

function contextNameFor(actors: ActorsFile, actor: string): string {
  return actors.actors[actor]?.contextName ?? actor;
}

function stepCallKey(step: ApiStep): string {
  return `${step.call.method.toUpperCase()} ${step.call.url}`;
}

function buildLogin(cfg: NavConfig, actors: ActorsFile, actor: string): LoginUiAction | LoginApiAction {
  const a = actors.actors[actor];
  if (!a) throw new CliError("E_NO_ACTOR", `Actor "${actor}" not found in actors.json`);
  if (cfg.login.kind === "ui") {
    return {
      type: "login-ui",
      url: appUrl(cfg, cfg.login.url),
      fields: cfg.login.fields,
      submit: cfg.login.submit,
      successCheck: cfg.login.successCheck,
      credentials: { username: a.username, password: a.password },
    };
  }
  const body = expandTemplate(cfg.login.bodyTemplate, { username: a.username, password: a.password }) as Record<string, unknown>;
  return {
    type: "login-api",
    method: cfg.login.call.method,
    url: apiUrl(cfg, cfg.login.call.url),
    body,
    storageSeed: cfg.login.storageSeed,
    appUrl: appUrl(cfg, "/"),
  };
}

function fixedParamKeys(step: ApiStep): string[] {
  return Object.entries(step.params ?? {}).filter(([, s]) => s.type === "fixed").map(([k]) => k);
}

function shouldProbe(step: RecipeStep): step is ApiStep {
  return isApiStep(step) && fixedParamKeys(step).length > 0;
}

function donePayload(dataDir: string, cfg: NavConfig, s: SessionFile): DonePayload {
  const r = s.recipe;
  const finalContext = r.finalContext ?? s.lastContext ?? Object.keys(s.contexts)[0] ?? "default";
  return {
    next: "done",
    sessionId: s.sessionId,
    finalNavigation: appUrl(cfg, r.finalNavigation),
    finalNavigationEntry: effectiveEntry(cfg, loadDataSourceMap(dataDir), r.finalNavigation),
    finalContext,
    shape: recipeShape(r),
    existingDataRefs: r.existingDataRefs,
    targetHint: r.targetHint ? { ...r.targetHint, url: substituteCaptured(r.targetHint.url, s.captured) } : undefined,
    verify: r.verify,
    captured: s.captured,
    probeReport: s.mode === "probe" ? s.probeResults : undefined,
    contexts: Object.keys(s.contexts),
  };
}

function substituteCaptured(text: string, captured: Record<string, unknown>): string {
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name: string) => (captured[name] !== undefined ? String(captured[name]) : m));
}

// ---------- commands ----------

export function executeStart(dataDir: string, cfg: NavConfig, recipeName: string, probe: boolean): {
  sessionId: string; recipeName: string; mode: "normal" | "probe"; totalSteps: number; actors: string[]; contexts: string[]; cleanedSessions: number;
  draft: boolean; pendingDecisions: number; shape: RecipeShape; finalNavigationEntry: EffectiveEntry; warnings: string[];
} {
  const recipe = loadRecipe(dataDir, recipeName);
  const actors = loadActors(dataDir);
  const used = [...new Set(recipe.steps.filter((s) => !s.disabled).map((s) => s.actor))];
  const missing = used.filter((a) => !actors.actors[a]);
  if (missing.length) throw new CliError("E_NO_ACTOR", `Recipe uses actors missing from actors.json: ${missing.join(", ")}`);
  const cleaned = cleanupSessions(dataDir).length;
  const s: SessionFile = {
    sessionId: newSessionId(),
    recipeName,
    recipe,
    mode: probe ? "probe" : "normal",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cursor: { stepIndex: nextEnabledIndex(recipe, 0), probeRound: 1 },
    captured: {},
    failures: {},
    contexts: {},
    probeResults: [],
    probeResolved: {},
    log: [{ at: new Date().toISOString(), event: "start", detail: { probe } }],
  };
  saveSession(dataDir, s);
  const shape = recipeShape(recipe);
  const finalNavigationEntry = effectiveEntry(cfg, loadDataSourceMap(dataDir), recipe.finalNavigation);
  const warnings: string[] = [];
  if (recipe.draft) warnings.push(`Recipe "${recipeName}" is still a draft with ${recipe.pendingDecisions?.length ?? 0} pending decision(s). Running it is fine for self-verification; resolve them and set "draft": false before relying on it.`);
  if (probe && shape !== "data") warnings.push(`--probe was requested but this recipe's shape is "${shape}": it has no API steps, so there are no parameters to probe. Run it without --probe.`);
  if (shape === "navigation-existing-data" && recipe.existingDataRefs?.length) {
    warnings.push(`This recipe assumes ${recipe.existingDataRefs.map((r) => `"${r.value}"`).join(", ")} already exists in the test database — no step creates it. If the run reaches the target but the screen is empty, that assumption is what broke, not the navigation.`);
  }
  return {
    sessionId: s.sessionId,
    recipeName,
    mode: s.mode,
    totalSteps: enabledSteps(recipe).length,
    actors: used,
    contexts: used.map((a) => contextNameFor(actors, a)),
    cleanedSessions: cleaned,
    draft: !!recipe.draft,
    pendingDecisions: recipe.pendingDecisions?.length ?? 0,
    shape,
    finalNavigationEntry,
    warnings,
  };
}

export function executeNext(dataDir: string, cfg: NavConfig, sessionId: string): NextInstruction | DonePayload {
  const s = loadSession(dataDir, sessionId);
  if (s.status !== "running") throw new CliError("E_SESSION_CLOSED", `Session ${sessionId} is ${s.status}${s.haltReason ? `: ${s.haltReason}` : ""}`);
  const actors = loadActors(dataDir);
  const total = enabledSteps(s.recipe).length;
  const warnings: string[] = [];

  if (s.cursor.stepIndex === -1) {
    s.status = "done";
    saveSession(dataDir, s);
    const done = donePayload(dataDir, cfg, s);
    deleteSession(dataDir, s.sessionId);
    return done;
  }

  const stepIndex = s.pending ? s.pending.stepIndex : s.cursor.stepIndex;
  const probeRound = s.pending ? s.pending.probeRound : s.cursor.probeRound;
  const step = s.recipe.steps[stepIndex];
  const contextName = contextNameFor(actors, step.actor);
  const repeat = !!s.pending;
  const attempt = s.pending ? s.pending.attempt : 1;

  const ctxState = s.contexts[contextName];
  const needsLogin = !ctxState?.loggedIn;
  let ensureContext: EnsureContext | undefined;
  if (needsLogin) {
    ensureContext = {
      contextName,
      actor: step.actor,
      login: buildLogin(cfg, actors, step.actor),
      storageReset: cfg.storageReset,
      reportStorageSnapshot: true,
    };
  }

  let switchTab: NextInstruction["switchTab"];
  if (s.lastContext && s.lastContext !== contextName && !needsLogin) {
    const relogin = cfg.auth.kind === "cookie";
    switchTab = {
      from: s.lastContext,
      to: contextName,
      reseedLocalStorage: cfg.auth.tokenSource?.area === "localStorage" ? ctxState?.storageSnapshot?.localStorage : undefined,
      relogin,
    };
    if (relogin) {
      warnings.push("auth.kind is cookie: one browser profile cannot hold two identities at once — log in again as this actor before continuing.");
      ensureContext = { contextName, actor: step.actor, login: buildLogin(cfg, actors, step.actor), storageReset: cfg.storageReset, reportStorageSnapshot: true };
    }
  }

  let action: FetchAction | UiActionAbs;
  let resolved: ResolvedStep | undefined;
  let captureSpec: Record<string, string> | undefined;
  let expect: ApiStep["expect"];
  if (isApiStep(step)) {
    const reuse = probeRound === 2 ? s.probeResolved[step.id] : undefined;
    if (probeRound === 2 && !reuse) throw new CliError("E_SESSION_CORRUPT", `Probe round 2 for ${step.id} has no round-1 values recorded.`);
    resolved = resolveApiStep(step, s.captured, reuse);
    const headers: Record<string, string> = { "content-type": "application/json", ...(step.headers ?? {}) };
    action = { type: "fetch", method: step.call.method.toUpperCase(), url: apiUrl(cfg, resolved.url), headers, body: resolved.body };
    captureSpec = step.capture;
    expect = step.expect;
  } else {
    const a = { ...step.action } as UiActionAbs;
    if ("gotoUrl" in a && a.gotoUrl) a.gotoUrl = appUrl(cfg, substituteCaptured(a.gotoUrl, s.captured));
    if (a.type === "navigate") a.url = appUrl(cfg, substituteCaptured(a.url, s.captured));
    if (a.type === "click") a.selector = substituteCaptured(a.selector, s.captured);
    if (a.type === "fill") a.fields = Object.fromEntries(Object.entries(a.fields).map(([k, v]) => [k, substituteCaptured(v, s.captured)]));
    action = a;
  }

  const pending: PendingStep = {
    stepIndex,
    stepId: step.id,
    probeRound,
    contextName,
    actor: step.actor,
    ensureContext: !!ensureContext,
    resolved,
    issuedAt: new Date().toISOString(),
    attempt,
  };
  s.pending = pending;
  s.log.push({ at: pending.issuedAt, event: repeat ? "reissue" : "issue", detail: { stepIndex, stepId: step.id, probeRound, attempt } });
  saveSession(dataDir, s);

  return {
    sessionId,
    stepIndex,
    stepId: step.id,
    totalSteps: total,
    attempt,
    repeat,
    probeRound: s.mode === "probe" ? probeRound : undefined,
    actor: step.actor,
    contextName,
    kind: step.kind,
    ensureContext,
    switchTab,
    auth: cfg.auth,
    action,
    captureSpec,
    expect,
    note: step.note,
    warnings,
  };
}

export function executeReport(dataDir: string, cfg: NavConfig, sessionId: string, input: ReportInput): ReportResult {
  const s = loadSession(dataDir, sessionId);
  if (s.status !== "running") throw new CliError("E_SESSION_CLOSED", `Session ${sessionId} is ${s.status}`);
  const pending = s.pending;
  if (!pending) throw new CliError("E_NO_PENDING", "Nothing to report: call execute-next first.");
  const step = s.recipe.steps[pending.stepIndex];
  const now = new Date().toISOString();

  if (pending.ensureContext && input.status === "ok") {
    s.contexts[pending.contextName] = { actor: pending.actor, loggedIn: true, storageSnapshot: input.storageSnapshot ?? s.contexts[pending.contextName]?.storageSnapshot };
  } else if (input.storageSnapshot) {
    s.contexts[pending.contextName] = { ...(s.contexts[pending.contextName] ?? { actor: pending.actor, loggedIn: true }), storageSnapshot: input.storageSnapshot };
  }

  let status = input.status;
  let message = input.message;
  const newCaptured: Record<string, unknown> = {};

  if (status === "ok" && isApiStep(step)) {
    const root = { response: input.response, status: input.httpStatus };
    const exp = step.expect;
    if (input.httpStatus !== undefined) {
      const okStatuses = exp?.status ?? null;
      const good = okStatuses ? okStatuses.includes(input.httpStatus) : input.httpStatus >= 200 && input.httpStatus < 300;
      if (!good) { status = "error"; message = `HTTP ${input.httpStatus}${input.response !== undefined ? `: ${JSON.stringify(input.response).slice(0, 500)}` : ""}`; }
    }
    if (status === "ok" && exp?.jsonPath) {
      const v = jsonPathGet(root, exp.jsonPath);
      const good = "equals" in exp ? JSON.stringify(v) === JSON.stringify(exp.equals) : !!v;
      if (!good) { status = "error"; message = `expect ${exp.jsonPath} failed (got ${JSON.stringify(v)})${input.response !== undefined ? `: ${JSON.stringify(input.response).slice(0, 500)}` : ""}`; }
    }
    if (status === "ok") {
      Object.assign(newCaptured, input.captured ?? {});
      for (const [key, path] of Object.entries(step.capture ?? {})) {
        if (key in newCaptured) continue;
        if (input.response === undefined) { status = "error"; message = `capture "${key}" needs --response (or --captured) but neither was provided`; break; }
        const v = jsonPathGet(root, path);
        if (v === undefined) { status = "error"; message = `capture "${key}" (${path}) not found in response: ${JSON.stringify(input.response).slice(0, 500)}`; break; }
        newCaptured[key] = v;
      }
    }
  } else if (status === "ok") {
    Object.assign(newCaptured, input.captured ?? {});
  }

  const callKey = isApiStep(step) ? stepCallKey(step) : `UI ${step.id}`;

  // ---- probe bookkeeping ----
  if (s.mode === "probe" && isApiStep(step) && shouldProbe(step)) {
    if (pending.probeRound === 1 && status === "ok") {
      s.probeResults.push({ stepId: step.id, call: callKey, fixedParams: fixedParamKeys(step), round1: { status: "ok" } });
      if (pending.resolved) s.probeResolved[step.id] = pending.resolved;
      s.log.push({ at: now, event: "probe-round1", detail: { stepId: step.id } });
      Object.assign(s.captured, newCaptured);
      s.failures[callKey] = 0;
      s.lastContext = pending.contextName;
      s.pending = undefined;
      s.cursor = { stepIndex: pending.stepIndex, probeRound: 2 };
      saveSession(dataDir, s);
      return { next: "continue", sessionId, stepIndex: pending.stepIndex, retry: false, captured: s.captured };
    }
    if (pending.probeRound === 2) {
      const dup = status === "error" && DUPLICATE_SIGNAL.test(message ?? "");
      const pr = s.probeResults.find((r) => r.stepId === step.id);
      if (pr) pr.round2 = { status, message, duplicateSignal: dup };
      for (const param of fixedParamKeys(step)) {
        upsertParamConstraint(dataDir, step.call.method, step.call.url, param, {
          unique: status === "error" ? (dup ? true : null) : false,
          source: "runtime-probe",
          observedError: status === "error" ? message : undefined,
          note: status === "ok" ? "identical request accepted twice" : dup ? "duplicate signal on identical request → use faker" : "second identical request failed without a duplicate signal",
        });
      }
      s.log.push({ at: now, event: "probe-round2", detail: { stepId: step.id, status, message, duplicateSignal: dup } });
      // Round 2 never counts as a failure and never advances captured values.
      s.lastContext = pending.contextName;
      s.pending = undefined;
      return advance(dataDir, cfg, s, pending);
    }
  }

  // ---- normal path ----
  if (status === "ok") {
    Object.assign(s.captured, newCaptured);
    s.failures[callKey] = 0;
    s.lastContext = pending.contextName;
    s.log.push({ at: now, event: "ok", detail: { stepId: step.id, captured: newCaptured } });
    s.pending = undefined;
    return advance(dataDir, cfg, s, pending);
  }

  const count = (s.failures[callKey] ?? 0) + 1;
  s.failures[callKey] = count;
  s.log.push({ at: now, event: "error", detail: { stepId: step.id, attempt: pending.attempt, message } });
  if (count >= cfg.execute.maxConsecutiveFailures) {
    s.status = "halted";
    s.haltReason = `${callKey} failed ${count} times in a row. Last error: ${message ?? "(no message)"}`;
    s.pending = undefined;
    saveSession(dataDir, s);
    return { next: "halt", sessionId, reason: s.haltReason, failures: s.failures, lastError: message, stepIndex: pending.stepIndex };
  }
  // keep pending so execute-next re-issues the same step (faker values are re-rolled).
  s.pending = { ...pending, attempt: pending.attempt + 1, resolved: undefined };
  saveSession(dataDir, s);
  return { next: "continue", sessionId, stepIndex: pending.stepIndex, retry: true, attempt: pending.attempt + 1, captured: s.captured };
}

function advance(dataDir: string, cfg: NavConfig, s: SessionFile, pending: PendingStep): ReportResult {
  const nextIndex = nextEnabledIndex(s.recipe, pending.stepIndex + 1);
  s.cursor = { stepIndex: nextIndex, probeRound: 1 };
  if (nextIndex === -1) {
    s.status = "done";
    s.log.push({ at: new Date().toISOString(), event: "done" });
    saveSession(dataDir, s);
    const done = donePayload(dataDir, cfg, s);
    deleteSession(dataDir, s.sessionId);
    return done;
  }
  saveSession(dataDir, s);
  return { next: "continue", sessionId: s.sessionId, stepIndex: nextIndex, retry: false, captured: s.captured };
}
