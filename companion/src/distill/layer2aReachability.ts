import type { NavigationEvent, RecorderEvent, RequestEvent } from "../types.js";
import { isRequestEvent } from "../types.js";
import { CliError } from "../errors.js";
import { pathnameOf } from "../execute/urls.js";
import { leavesOf, urlLeaves } from "./leaves.js";

export interface ReachabilityResult {
  anchor: NavigationEvent;
  /** navigation immediately before the anchor with a different path — the natural "上一站" guess */
  previousPage?: NavigationEvent;
  /** kept mutating requests in chronological order */
  kept: RequestEvent[];
  reasons: Record<string, string[]>;
  droppedUnreachable: RequestEvent[];
  droppedFailed: RequestEvent[];
  droppedAfterAnchor: RequestEvent[];
  seedCount: number;
  /** read-only requests the target page issued while it was open — what the screen asked for */
  targetWindowReads: RequestEvent[];
}

export function samePath(a: string, b: string): boolean {
  const norm = (s: string) => pathnameOf(s).replace(/\/+$/, "").toLowerCase() || "/";
  return norm(a) === norm(b);
}

export function findAnchor(events: RecorderEvent[], targetUrl: string): NavigationEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "navigation" && samePath(ev.url, targetUrl)) return ev;
  }
  return undefined;
}

export function recentNavigationPaths(events: RecorderEvent[], limit = 20): string[] {
  const seen: string[] = [];
  for (let i = events.length - 1; i >= 0 && seen.length < limit; i--) {
    const ev = events[i];
    if (ev.type !== "navigation") continue;
    const path = pathnameOf(ev.url);
    if (!seen.includes(path)) seen.push(path);
  }
  return seen;
}

/**
 * Layer 2a: dead-code elimination from the target page backwards.
 *
 * 1. anchor = last navigation to `targetUrl`; everything after it is out of scope.
 * 2. seed = values the target page asked for / displayed (bodies + responses of read requests
 *    issued while on the target page, plus the anchor URL itself).
 * 3. Walk mutating requests backwards; keep one when any value in its response is referenced by
 *    the seed or by an already-kept request (it produced something that matters), or when its own
 *    request references such a value (it operated on an entity that matters — e.g. "submit" calls
 *    whose response carries no id). A kept request's values become references too. Iterate to a
 *    fixpoint.
 */
export function reachability(events: RecorderEvent[], targetUrl: string, isReadOnly: (ev: RequestEvent) => boolean): ReachabilityResult {
  const anchor = findAnchor(events, targetUrl);
  if (!anchor) {
    throw new CliError("E_NO_ANCHOR", `No navigation to ${pathnameOf(targetUrl)} found in the claimed range. Pass the route the user actually reached (see details.recentNavigations).`, {
      recentNavigations: recentNavigationPaths(events),
    });
  }
  const anchorSeq = anchor.seq ?? Number.MAX_SAFE_INTEGER;
  const anchorIndex = events.indexOf(anchor);

  let previousPage: NavigationEvent | undefined;
  for (let i = anchorIndex - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "navigation" && !samePath(ev.url, anchor.url)) { previousPage = ev; break; }
  }

  // Window: after anchor until the next navigation away from the target page.
  const refs = new Set<string>();
  for (const l of urlLeaves(anchor.url)) refs.add(l.value);
  let seedCount = refs.size;
  const targetWindowReads: RequestEvent[] = [];
  for (let i = anchorIndex + 1; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "navigation") { if (!samePath(ev.url, anchor.url)) break; continue; }
    if (!isRequestEvent(ev) || !isReadOnly(ev)) continue;
    targetWindowReads.push(ev);
    for (const l of leavesOf(ev.requestBody)) { refs.add(l.value); seedCount++; }
    for (const l of urlLeaves(ev.url)) { refs.add(l.value); seedCount++; }
    for (const l of leavesOf(ev.responseBody)) { refs.add(l.value); seedCount++; }
  }

  const before = events.filter((ev): ev is RequestEvent => isRequestEvent(ev) && (ev.seq ?? 0) < anchorSeq);
  const after = events.filter((ev): ev is RequestEvent => isRequestEvent(ev) && (ev.seq ?? 0) > anchorSeq && !isReadOnly(ev));
  const mutating = before.filter((ev) => !isReadOnly(ev));
  const droppedFailed = mutating.filter((ev) => ev.status >= 400 || ev.status === 0);
  const candidates = mutating.filter((ev) => !droppedFailed.includes(ev));

  const keptSet = new Set<RequestEvent>();
  const reasons: Record<string, string[]> = {};
  const responseLeaves = new Map<RequestEvent, string[]>();
  const requestLeaves = new Map<RequestEvent, string[]>();
  for (const ev of candidates) {
    responseLeaves.set(ev, [...new Set(leavesOf(ev.responseBody).map((l) => l.value))]);
    requestLeaves.set(ev, [...new Set([...leavesOf(ev.requestBody).map((l) => l.value), ...urlLeaves(ev.url).map((l) => l.value)])]);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const ev = candidates[i];
      if (keptSet.has(ev)) continue;
      const produced = (responseLeaves.get(ev) ?? []).filter((v) => refs.has(v));
      const operated = (requestLeaves.get(ev) ?? []).filter((v) => refs.has(v));
      if (produced.length === 0 && operated.length === 0) continue;
      keptSet.add(ev);
      reasons[ev.requestId] = [
        ...produced.slice(0, 3).map((v) => `produced "${truncate(v)}" which is referenced later`),
        ...operated.slice(0, 3).map((v) => `operates on "${truncate(v)}" which the target depends on`),
      ];
      for (const v of requestLeaves.get(ev) ?? []) refs.add(v);
      for (const v of responseLeaves.get(ev) ?? []) refs.add(v);
      changed = true;
    }
  }

  const kept = candidates.filter((ev) => keptSet.has(ev));
  return {
    anchor,
    previousPage,
    kept,
    reasons,
    droppedUnreachable: candidates.filter((ev) => !keptSet.has(ev)),
    droppedFailed,
    droppedAfterAnchor: after,
    seedCount,
    targetWindowReads,
  };
}

function truncate(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
