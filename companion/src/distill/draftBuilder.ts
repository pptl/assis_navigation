import type { NavConfig, NavigationEvent, RequestEvent } from "../types.js";
import type { ApiStep, ConstraintEvidence, ParamSpec, PendingDecision, Recipe } from "../recipe.js";
import type { SchemaHint, SchemaProvider } from "./schemaEvidence/index.js";
import { leavesOf, tryParseJson, type Leaf } from "./leaves.js";
import { relativeToApiBase, pathnameOf } from "../execute/urls.js";
import { jsonPointerGet } from "../execute/jsonpath.js";

export interface DraftInput {
  cfg: NavConfig;
  recipeName: string;
  description: string;
  targetUrl: string;
  kept: RequestEvent[];
  authEvent?: RequestEvent;
  previousPage?: NavigationEvent;
  providers: SchemaProvider[];
  defaultActor: string;
  actorNames: string[];
  claimedRange: { from: string; to: string };
  anchorSeq?: number;
  rawClaimFile?: string;
}

export interface DraftOutput {
  recipe: Recipe;
  probeRecommended: boolean;
  stats: { steps: number; params: number; captured: number; codeEvidence: number };
}

const MAX_PARAMS_PER_STEP = 40;

interface CapturedRef { stepIndex: number; name: string }

function pointerToJsonPath(pointer: string): string {
  const segs = pointer.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  return "$.response" + segs.map((s) => (/^\d+$/.test(s) ? `[${s}]` : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? `.${s}` : `["${s}"]`)).join("");
}

function captureName(pointer: string, used: Set<string>, stepId: string): string {
  const last = pointer.split("/").filter((s) => s && !/^\d+$/.test(s)).pop() ?? "value";
  const base = last.replace(/[^A-Za-z0-9_]/g, "_");
  if (!used.has(base)) { used.add(base); return base; }
  const alt = `${stepId}_${base}`;
  used.add(alt);
  return alt;
}

function guessFaker(value: unknown): ParamSpec {
  if (typeof value === "number") return { type: "faker", fn: "number.int", args: [{ min: 1000, max: 9999999 }] };
  const s = String(value);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return { type: "faker", fn: "string.uuid" };
  if (/^\d+$/.test(s)) return { type: "faker", fn: "string.numeric", args: [s.length] };
  if (/@/.test(s)) return { type: "faker", fn: "internet.email" };
  return { type: "faker", fn: "string.alphanumeric", args: [Math.max(6, Math.min(s.length, 16))] };
}

function describeHint(h: SchemaHint): string {
  const bits: string[] = [];
  if (h.unique) bits.push("unique");
  if (h.required) bits.push("required");
  if (h.type) bits.push(`type=${h.type}`);
  if (h.format) bits.push(`format=${h.format}`);
  if (h.minLength !== undefined) bits.push(`minLength=${h.minLength}`);
  if (h.maxLength !== undefined) bits.push(`maxLength=${h.maxLength}`);
  if (h.enum) bits.push(`enum=${JSON.stringify(h.enum).slice(0, 80)}`);
  if (h.note) bits.push(h.note);
  return bits.join(", ") || "found in schema";
}

export function buildDraft(input: DraftInput): DraftOutput {
  const { cfg, kept, providers } = input;
  const sorted = [...kept].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const pending: PendingDecision[] = [];
  const steps: ApiStep[] = [];
  const usedCaptureNames = new Set<string>();
  /** response value → where it was produced */
  const producedBy = new Map<string, { stepIndex: number; pointer: string }>();
  let paramCount = 0;
  let capturedCount = 0;
  let codeEvidence = 0;
  let probeRecommended = false;

  // For variation detection: call key → pointer → distinct values
  const variation = new Map<string, Map<string, Set<string>>>();
  for (const ev of sorted) {
    const key = `${ev.method.toUpperCase()} ${relativeToApiBase(cfg, ev.url).url.split("?")[0]}`;
    const m = variation.get(key) ?? new Map<string, Set<string>>();
    for (const l of leavesOf(ev.requestBody)) {
      const set = m.get(l.pointer) ?? new Set<string>();
      set.add(l.value);
      m.set(l.pointer, set);
    }
    variation.set(key, m);
  }
  const occurrences = new Map<string, string[]>();

  sorted.forEach((ev, stepIndex) => {
    const stepId = `s${stepIndex + 1}`;
    const rel = relativeToApiBase(cfg, ev.url);
    const [urlPath, query] = rel.url.split("?");
    const callKey = `${ev.method.toUpperCase()} ${urlPath}`;
    occurrences.set(callKey, [...(occurrences.get(callKey) ?? []), stepId]);
    if (rel.external) pending.push({ kind: "external", stepId, message: `Step ${stepId} calls ${ev.url}, which is outside apiBases — confirm it belongs to the recipe or add the base to config.apiBases.` });

    const parsedBody = tryParseJson(ev.requestBody);
    const step: ApiStep = {
      id: stepId,
      actor: input.defaultActor,
      kind: "api",
      call: { method: ev.method.toUpperCase(), url: query ? `${urlPath}?${query}` : urlPath },
      note: `recorded ${ev.ts} (requestId ${ev.requestId}, status ${ev.status})`,
    };
    if (parsedBody !== undefined) step.bodyTemplate = parsedBody;
    else if (ev.requestBody) { step.bodyTemplate = ev.requestBody; step.note += " — body is not JSON; params cannot be templated"; }
    const contentType = Object.entries(ev.requestHeaders).find(([k]) => k.toLowerCase() === "content-type")?.[1];
    if (contentType && !/application\/json/i.test(contentType)) step.headers = { "content-type": contentType };

    // URL placeholders from captured values
    const urlParams: Record<string, ParamSpec> = {};
    if (!rel.external) {
      const segs = urlPath.split("/");
      let changed = false;
      for (let i = 0; i < segs.length; i++) {
        const hit = producedBy.get(segs[i]);
        if (!hit || segs[i].length < 4) continue;
        const name = ensureCapture(hit);
        urlParams[name] = { type: "captured", ref: name };
        segs[i] = `{${name}}`;
        changed = true;
      }
      if (changed) step.call.url = query ? `${segs.join("/")}?${query}` : segs.join("/");
      if (Object.keys(urlParams).length) step.urlParams = urlParams;
    }

    // Body params
    if (parsedBody !== undefined && typeof parsedBody === "object" && parsedBody !== null) {
      const params: Record<string, ParamSpec> = {};
      const evidence: Record<string, ConstraintEvidence> = {};
      const leaves = scalarLeaves(parsedBody);
      const variationForCall = variation.get(callKey);
      for (const leaf of leaves.slice(0, MAX_PARAMS_PER_STEP)) {
        const raw = jsonPointerGet(parsedBody, leaf.pointer);
        const produced = producedBy.get(leaf.value);
        if (produced && produced.stepIndex < stepIndex) {
          const name = ensureCapture(produced);
          params[leaf.pointer] = { type: "captured", ref: name };
          evidence[leaf.pointer] = { source: "none", note: `value matched response of ${steps[produced.stepIndex].id}` };
          capturedCount++;
          continue;
        }
        let hint: SchemaHint | null = null;
        for (const pv of providers) { hint = pv.lookup(step.call, leaf.pointer); if (hint) break; }
        if (hint) {
          codeEvidence++;
          evidence[leaf.pointer] = { source: "code", location: hint.location, note: describeHint(hint) };
          params[leaf.pointer] = hint.unique ? guessFaker(raw) : { type: "fixed", value: raw };
        } else {
          evidence[leaf.pointer] = { source: "none" };
          params[leaf.pointer] = { type: "fixed", value: raw };
          probeRecommended = true;
        }
        const distinct = variationForCall?.get(leaf.pointer);
        if (distinct && distinct.size > 1 && params[leaf.pointer].type === "fixed") {
          pending.push({
            kind: "typeGuess", stepId, param: leaf.pointer,
            message: `${callKey} was recorded ${distinct.size} times with different values for ${leaf.pointer} (${[...distinct].slice(0, 3).map((v) => JSON.stringify(v)).join(", ")}) — likely needs faker.`,
            suggestion: guessFaker(raw),
          });
        }
        paramCount++;
      }
      if (Object.keys(params).length) step.params = params;
      if (Object.keys(evidence).length) step.constraintEvidence = evidence;
    }

    steps.push(step);

    // Register response values for later steps to reference
    for (const l of leavesOf(ev.responseBody)) {
      if (!producedBy.has(l.value)) producedBy.set(l.value, { stepIndex, pointer: l.pointer });
    }
  });

  function ensureCapture(hit: { stepIndex: number; pointer: string }): string {
    const step = steps[hit.stepIndex];
    step.capture ??= {};
    const path = pointerToJsonPath(hit.pointer);
    const existing = Object.entries(step.capture).find(([, p]) => p === path);
    if (existing) return existing[0];
    const name = captureName(hit.pointer, usedCaptureNames, step.id);
    step.capture[name] = path;
    return name;
  }

  // Layer 3: duplicates
  for (const [callKey, ids] of occurrences) {
    if (ids.length > 1) {
      pending.push({
        kind: "duplicate", message: `${callKey} appears ${ids.length} times (${ids.join(", ")}). Keep all if each result is needed; otherwise disable the extra steps (set "disabled": true).`,
        options: ids, suggestion: "keep-last",
      });
    }
  }

  const targetPath = pathnameOf(input.targetUrl);
  const prevPath = input.previousPage ? pathnameOf(input.previousPage.url) + (safeSearch(input.previousPage.url)) : "/";
  pending.push({
    kind: "confirmFinalNavigation",
    message: `finalNavigation is guessed from the page visited right before the target (${prevPath}). It must be a stable page that the current change will NOT touch — adjust if needed.`,
    suggestion: prevPath,
    options: [prevPath, targetPath],
  });
  pending.push({ kind: "confirmTargetHint", message: `targetHint.url is the target route (${targetPath}). Describe in targetHint.note how to make the last hop from finalNavigation (which row to click, etc.).`, suggestion: targetPath });
  if (input.actorNames.length > 1) {
    pending.push({ kind: "actor", message: `All steps default to actor "${input.defaultActor}". actors.json also defines: ${input.actorNames.filter((a) => a !== input.defaultActor).join(", ")}. Set the right actor per step for multi-role flows.`, options: input.actorNames });
  }

  const recipe: Recipe = {
    name: input.recipeName,
    description: input.description,
    createdAt: new Date().toISOString(),
    targetUrl: targetPath,
    auth: input.authEvent ? {
      role: "auth",
      call: { method: input.authEvent.method.toUpperCase(), url: relativeToApiBase(cfg, input.authEvent.url).url.split("?")[0] },
      bodyShape: bodyShape(input.authEvent.requestBody),
    } : undefined,
    steps,
    finalNavigation: prevPath,
    finalContext: input.defaultActor,
    targetHint: { url: targetPath, note: "TODO: describe the last hop from finalNavigation into the target screen" },
    verify: { selectors: [], textIncludes: [] },
    source: { claimedRange: input.claimedRange, anchorSeq: input.anchorSeq, rawClaimFile: input.rawClaimFile, description: input.description },
    draft: true,
    pendingDecisions: pending,
  };
  return { recipe, probeRecommended, stats: { steps: steps.length, params: paramCount, captured: capturedCount, codeEvidence } };
}

function safeSearch(url: string): string {
  try { return new URL(url).search; } catch { return ""; }
}

function bodyShape(body: string | null): string[] {
  const j = tryParseJson(body);
  if (j && typeof j === "object" && !Array.isArray(j)) return Object.keys(j as Record<string, unknown>);
  return [];
}

/** All scalar leaves (any string/number) with pointers — unlike leavesOf, includes short values so they can be templated. */
function scalarLeaves(body: unknown): Leaf[] {
  const out: Leaf[] = [];
  const walk = (v: unknown, pointer: string, depth: number): void => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === "string" || typeof v === "number") { out.push({ value: String(v), pointer }); return; }
    if (typeof v === "boolean") return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${pointer}/${i}`, depth + 1)); return; }
    if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1);
  };
  walk(body, "", 0);
  return out;
}
