/**
 * Value extraction for reachability analysis. A "leaf" is a scalar that could plausibly identify a
 * record: a non-trivial string or a large number. Booleans, tiny numbers, dates and boilerplate
 * words are excluded to keep matches meaningful.
 */

const STOP = new Set(["true", "false", "null", "undefined", "success", "error", "string", "number", "object", "message", "data", "result", "ok", "none", "web"]);
const DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/;
const MIN_STR = 4;
const MIN_NUM = 1000;

export function tryParseJson(text: string | null | undefined): unknown {
  if (text == null) return undefined;
  const t = text.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[" && t[0] !== '"')) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

export interface Leaf {
  value: string;
  /** JSON pointer inside the parsed body ("/data/id") or "" for text tokens */
  pointer: string;
}

export function leavesOf(text: string | null | undefined, opts: { includeTokens?: boolean } = {}): Leaf[] {
  const out: Leaf[] = [];
  const json = tryParseJson(text);
  if (json !== undefined) {
    walk(json, "", out, 0);
    return out;
  }
  if (text && opts.includeTokens !== false) {
    for (const tok of text.split(/[&=,;\s|]+/)) if (acceptString(tok)) out.push({ value: tok, pointer: "" });
  }
  return out;
}

function walk(v: unknown, pointer: string, out: Leaf[], depth: number): void {
  if (depth > 12) return;
  if (v === null || v === undefined) return;
  if (typeof v === "string") { if (acceptString(v)) out.push({ value: v.trim(), pointer }); return; }
  if (typeof v === "number") { if (Number.isFinite(v) && Math.abs(v) >= MIN_NUM) out.push({ value: String(v), pointer }); return; }
  if (typeof v === "boolean") return;
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${pointer}/${i}`, out, depth + 1)); return; }
  if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${pointer}/${escape(k)}`, out, depth + 1);
}

function escape(k: string): string {
  return k.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function acceptString(s: string): boolean {
  const t = s.trim();
  if (t.length < MIN_STR) return false;
  if (STOP.has(t.toLowerCase())) return false;
  if (DATE_RE.test(t)) return false;
  if (/^\d+$/.test(t) && Number(t) < MIN_NUM) return false;
  return true;
}

/** Leaves of a URL: path segments and query values. */
export function urlLeaves(url: string): Leaf[] {
  const out: Leaf[] = [];
  try {
    const u = new URL(url);
    for (const seg of u.pathname.split("/")) if (acceptString(seg)) out.push({ value: seg, pointer: "" });
    u.searchParams.forEach((v) => { if (acceptString(v)) out.push({ value: v, pointer: "" }); });
  } catch {
    for (const tok of url.split(/[/?&=]+/)) if (acceptString(tok)) out.push({ value: tok, pointer: "" });
  }
  return out;
}
