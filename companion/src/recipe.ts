import type { ApiCall } from "./types.js";

// ---------- Precondition recipe (.nav-recorder/preconditions/<name>.json) ----------

export type ParamSpec =
  | { type: "faker"; fn: string; args?: unknown[] }
  | { type: "fixed"; value: unknown }
  | { type: "captured"; ref: string };

export interface ConstraintEvidence {
  source: "code" | "runtime-probe" | "none";
  /** e.g. "swagger/Order.json#/components/schemas/OrderCreate/required" */
  location?: string;
  /** full error message observed on the duplicate probe */
  observedError?: string;
  note?: string;
}

export interface StepExpect {
  /** acceptable HTTP statuses (default: 2xx) */
  status?: number[];
  /** JSON path into the response that must be truthy / equal `equals` */
  jsonPath?: string;
  equals?: unknown;
}

export interface ApiStep {
  id: string;
  actor: string;
  kind: "api";
  call: ApiCall;
  /** Raw request body as recorded (JSON). `params` override positions inside it. */
  bodyTemplate?: unknown;
  /** key = JSON pointer into bodyTemplate ("/a/b"), or a bare top-level property name. */
  params?: Record<string, ParamSpec>;
  /** values substituted into {placeholders} of call.url only (never written into the body) */
  urlParams?: Record<string, ParamSpec>;
  headers?: Record<string, string>;
  /** captured name → JSON path into the response ("$.data.id") */
  capture?: Record<string, string>;
  expect?: StepExpect;
  constraintEvidence?: Record<string, ConstraintEvidence>;
  disabled?: boolean;
  note?: string;
}

export type UiAction =
  | { type: "navigate"; url: string }
  | { type: "click"; gotoUrl?: string; selector: string }
  | { type: "fill"; gotoUrl?: string; fields: Record<string, string> }
  | { type: "waitFor"; selector?: string; text?: string; urlIncludes?: string; timeoutMs?: number };

export interface UiStep {
  id: string;
  actor: string;
  kind: "ui";
  action: UiAction;
  disabled?: boolean;
  note?: string;
}

export type RecipeStep = ApiStep | UiStep;

/** One recorded click of the last hop (finalNavigation → target), for the Agent to replay by hand. */
export interface TargetHintClick {
  text?: string;
  role?: string;
  href?: string;
  /** alternative selectors, most stable first (aria/..., [data-testid=...], #id, css, text/...) */
  selectors: string[];
  /** target had no navigation semantics — verify before relying on it */
  weak?: boolean;
}

/**
 * What kind of preparation this recipe actually is. Decided mechanically when it is distilled, not
 * guessed up front: the three differ in what can break and therefore in what is worth verifying.
 *  - `navigation`: nothing to create, just a route through the app. Only the last hop can break.
 *  - `navigation-existing-data`: also nothing to create, but the target screen shows a specific
 *    record the recording never created — the recipe silently assumes it is already in the database.
 *  - `data`: has API steps that build state; parameter uniqueness and schema drift matter.
 */
export type RecipeShape = "navigation" | "navigation-existing-data" | "data";

/** A record the target screen depends on that no step in the recipe creates. */
export interface ExistingDataRef {
  /** the identifying value itself (an id, a code, a plate number…) */
  value: string;
  /** the target screen's request that used it, e.g. "POST Apps/AppDetail" */
  usedBy: string;
  /** the earlier response it came from, e.g. "POST Apps/AppSearch" */
  seenIn: string;
}

export interface Recipe {
  name: string;
  description?: string;
  createdAt: string;
  /** the screen this recipe prepares for (never navigated by the recipe itself) */
  targetUrl?: string;
  /** normalised on save; absent on recipes distilled before shapes existed */
  shape?: RecipeShape;
  /** shape "navigation-existing-data" only: what must already exist for this recipe to work */
  existingDataRefs?: ExistingDataRef[];
  /** the recorded login request — metadata only, never replayed */
  auth?: { role: "auth"; call: ApiCall; bodyShape: string[] };
  steps: RecipeStep[];
  /** "上一站": a stable page not touched by the current change */
  finalNavigation: string;
  finalContext?: string;
  targetHint?: { url: string; note?: string; clicks?: TargetHintClick[] };
  verify?: { selectors?: string[]; textIncludes?: string[] };
  source?: { claimedRange?: { from: string; to: string }; anchorSeq?: number; rawClaimFile?: string; description?: string };
  /** true until Agent dev has resolved pendingDecisions and confirmed finalNavigation/targetHint */
  draft?: boolean;
  pendingDecisions?: PendingDecision[];
}

export interface PendingDecision {
  kind: "duplicate" | "typeGuess" | "confirmFinalNavigation" | "confirmTargetHint" | "missingSchema" | "external" | "actor" | "newActor" | "existingData" | "excludedSteps";
  stepId?: string;
  param?: string;
  message: string;
  options?: unknown[];
  suggestion?: unknown;
}

export interface RecipeSummary {
  name: string;
  description?: string;
  targetUrl?: string;
  shape: RecipeShape;
  finalNavigation: string;
  createdAt: string;
  steps: number;
  file: string;
}

/** How a recipe matched a `list` query. `section` = same first path segment. */
export type RecipeMatch = "exact" | "prefix" | "section" | "keyword";

export interface RecipeMatchResult extends RecipeSummary {
  matched: RecipeMatch[];
}

export function isApiStep(s: RecipeStep): s is ApiStep {
  return s.kind === "api";
}

/**
 * The shape a recipe has *now*. Enabled API steps are decisive — an Agent that adds one to a
 * navigation recipe has turned it into a data recipe — so the stored value only settles the two
 * navigation flavours, which cannot be told apart from the steps alone.
 */
export function recipeShape(r: Pick<Recipe, "steps" | "shape">): RecipeShape {
  if ((r.steps ?? []).some((s) => isApiStep(s) && !s.disabled)) return "data";
  return r.shape === "navigation-existing-data" ? "navigation-existing-data" : "navigation";
}

/** Structural validation; returns a list of problems (empty = valid). */
export function validateRecipe(r: unknown): string[] {
  const errors: string[] = [];
  const rec = r as Partial<Recipe>;
  if (!rec || typeof rec !== "object") return ["recipe must be an object"];
  if (!rec.name || !/^[A-Za-z0-9._-]+$/.test(rec.name)) errors.push("name must match [A-Za-z0-9._-]+");
  if (!Array.isArray(rec.steps)) errors.push("steps must be an array");
  if (typeof rec.finalNavigation !== "string" || !rec.finalNavigation) errors.push("finalNavigation is required");
  const ids = new Set<string>();
  for (const [i, s] of (rec.steps ?? []).entries()) {
    const where = `steps[${i}]`;
    if (!s || typeof s !== "object") { errors.push(`${where} must be an object`); continue; }
    if (!s.id) errors.push(`${where}.id is required`);
    else if (ids.has(s.id)) errors.push(`${where}.id duplicated: ${s.id}`);
    else ids.add(s.id);
    if (!s.actor) errors.push(`${where}.actor is required`);
    if (s.kind === "api") {
      if (!s.call?.method || !s.call?.url) errors.push(`${where}.call.method/url are required`);
      for (const [k, spec] of [...Object.entries(s.params ?? {}), ...Object.entries(s.urlParams ?? {})]) {
        const t = (spec as ParamSpec).type;
        if (t === "faker" && !(spec as { fn?: string }).fn) errors.push(`${where}.params[${k}] faker needs fn`);
        else if (t === "captured" && !(spec as { ref?: string }).ref) errors.push(`${where}.params[${k}] captured needs ref`);
        else if (!["faker", "fixed", "captured"].includes(t)) errors.push(`${where}.params[${k}] has unknown type ${String(t)}`);
      }
    } else if (s.kind === "ui") {
      const a = s.action as UiAction | undefined;
      if (!a || !["navigate", "click", "fill", "waitFor"].includes(a.type)) errors.push(`${where}.action.type must be navigate | click | fill | waitFor`);
      else if (a.type === "navigate" && !a.url) errors.push(`${where}.action.url is required`);
      else if (a.type === "click" && !a.selector) errors.push(`${where}.action.selector is required`);
      else if (a.type === "fill" && (!a.fields || typeof a.fields !== "object")) errors.push(`${where}.action.fields is required`);
    } else {
      errors.push(`${where}.kind must be api | ui`);
    }
  }
  return errors;
}
