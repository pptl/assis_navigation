import { faker as defaultFaker, allFakers, type Faker } from "@faker-js/faker";
import type { ApiStep, ParamSpec } from "../recipe.js";
import { CliError } from "../errors.js";
import { jsonPointerSet } from "./jsonpath.js";

export interface ResolvedStep {
  body: unknown;
  /** param key (JSON pointer) → resolved value */
  values: Record<string, unknown>;
  /** URL with {placeholders} substituted */
  url: string;
}

export function resolveFaker(fn: string, args: unknown[] = []): unknown {
  let fk: Faker = defaultFaker;
  let path = fn;
  const colon = fn.indexOf(":");
  if (colon !== -1) {
    const locale = fn.slice(0, colon);
    const localized = (allFakers as Record<string, Faker>)[locale];
    if (!localized) throw new CliError("E_FAKER", `Unknown faker locale "${locale}" in ${fn}`);
    fk = localized;
    path = fn.slice(colon + 1);
  }
  const segs = path.split(".");
  let cur: unknown = fk;
  let parent: unknown = undefined;
  for (const s of segs) {
    if (cur === null || typeof cur !== "object" && typeof cur !== "function") throw new CliError("E_FAKER", `Unknown faker function: ${fn}`);
    parent = cur;
    cur = (cur as Record<string, unknown>)[s];
  }
  if (typeof cur !== "function") throw new CliError("E_FAKER", `Faker path is not a function: ${fn}`);
  return (cur as (...a: unknown[]) => unknown).apply(parent, args);
}

export function resolveParamSpec(spec: ParamSpec, captured: Record<string, unknown>, key: string): unknown {
  switch (spec.type) {
    case "fixed":
      return spec.value;
    case "faker":
      return resolveFaker(spec.fn, spec.args);
    case "captured":
      if (!(spec.ref in captured)) throw new CliError("E_CAPTURE_MISSING", `Param ${key} references captured "${spec.ref}" which has not been captured yet. Captured so far: ${Object.keys(captured).join(", ") || "(none)"}`);
      return captured[spec.ref];
    default:
      throw new CliError("E_RECIPE_INVALID", `Param ${key} has unknown type ${(spec as { type: string }).type}`);
  }
}

function normalizePointer(key: string): string {
  return key.startsWith("/") ? key : `/${key}`;
}

function substituteUrl(url: string, values: Record<string, unknown>, urlValues: Record<string, unknown>, captured: Record<string, unknown>): string {
  return url.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name: string) => {
    const fromValues = urlValues[name] ?? Object.entries(values).find(([k]) => k === `/${name}` || k === name)?.[1];
    const v = fromValues ?? captured[name];
    if (v === undefined) throw new CliError("E_CAPTURE_MISSING", `URL placeholder {${name}} in ${url} has no value (urlParams, params or captured).`);
    return encodeURIComponent(String(v));
  });
}

/** Build the concrete request body/url for an api step. Pass `reuse` to replay the exact values from a previous resolution (probe round 2). */
export function resolveApiStep(step: ApiStep, captured: Record<string, unknown>, reuse?: ResolvedStep): ResolvedStep {
  if (reuse) return { body: structuredClone(reuse.body), values: { ...reuse.values }, url: reuse.url };
  let body: unknown = step.bodyTemplate === undefined ? {} : structuredClone(step.bodyTemplate);
  const values: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(step.params ?? {})) {
    const pointer = normalizePointer(key);
    const v = resolveParamSpec(spec, captured, key);
    values[pointer] = v;
    body = jsonPointerSet(body, pointer, v);
  }
  const urlValues: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(step.urlParams ?? {})) {
    const v = resolveParamSpec(spec, captured, `url:${name}`);
    urlValues[name] = v;
    values[`url:${name}`] = v;
  }
  if (step.bodyTemplate === undefined && Object.keys(step.params ?? {}).length === 0) body = undefined;
  return { body, values, url: substituteUrl(step.call.url, values, urlValues, captured) };
}
