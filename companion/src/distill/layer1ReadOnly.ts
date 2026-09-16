import type { NavConfig, RequestEvent } from "../types.js";
import { compileReadOnlyPatterns } from "../config.js";
import { pathnameOf, relativeToApiBase } from "../execute/urls.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Layer 1: GET/HEAD/OPTIONS are always read-only. Projects whose reads are POSTs (very common in
 * enterprise .NET apps) add `readOnlyPatterns` — anchored regexes tested against the URL path,
 * both as a full pathname and relative to the configured API bases.
 */
export function makeReadOnlyClassifier(cfg: NavConfig): (ev: RequestEvent) => boolean {
  const patterns = compileReadOnlyPatterns(cfg);
  return (ev) => {
    if (SAFE_METHODS.has(ev.method.toUpperCase())) return true;
    if (!patterns.length) return false;
    const full = pathnameOf(ev.url);
    const rel = relativeToApiBase(cfg, ev.url).url.split("?")[0];
    return patterns.some((re) => re.test(full) || re.test(rel));
  };
}
