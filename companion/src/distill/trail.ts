import type { InteractionEvent, NavigationEvent, RecorderEvent } from "../types.js";
import { isInteractionEvent } from "../types.js";
import { pathnameOf } from "../execute/urls.js";
import { samePath } from "./layer2aReachability.js";

/**
 * Path assembly ("拼路徑"): turns navigations + recorded interactions into hops the Agent can
 * replay, without any value-flow analysis. Mechanical rules, modelled on Chrome DevTools Recorder
 * and Playwright codegen:
 *
 * 1. Attach: a navigation the user clicked into (transitionType not typed/reload/...) is attached to
 *    the last click that happened within `attachWindowMs` before it in the same tab.
 * 2. Visits: consecutive navigations to the same path (reloads) are one visit. Revisiting a path
 *    already on the stack folds the detour away: /Home → /X → /Home → /Target becomes /Home → /Target,
 *    and the LAST visit of each page is the one whose clicks count.
 * 3. Hops: clicks recorded while on page i (between its last visit and the next navigation) are the
 *    way from page i to page i+1. Obvious noise (clicks on body / form fields) is dropped; the rest is
 *    kept, marked `weak` when the target has no navigation semantics so the Agent can judge.
 */

export interface TrailClick {
  seq: number;
  ts: string;
  kind: "click" | "key";
  pageUrl: string;
  text?: string;
  role?: string;
  href?: string;
  selectors: string[];
  ancestors?: { tag: string; role?: string; name?: string }[];
  /** path this click navigated to (attached from the following navigation) */
  assertedNavigation?: string;
  /** target had no navigation semantics (plain div/span without role) — kept for the Agent to judge */
  weak?: boolean;
}

export interface Hop {
  from: string;
  to: string;
  /** seq of the navigation that arrived at `to` */
  navSeq: number;
  transitionType?: string;
  clicks: TrailClick[];
}

export interface Trail {
  /** de-looped page sequence, ending at the target */
  pages: string[];
  hops: Hop[];
  dropped: { noiseClicks: number; inputs: number };
}

export interface TrailOptions {
  /** only events with seq >= fromSeq are considered (the anchor's browsing segment) */
  fromSeq?: number;
  /** a navigation is attached to a click at most this long before it (Playwright uses 5 s) */
  attachWindowMs?: number;
}

/** transitionTypes that are never the result of a click on the page (DevTools: "unrelated navigations") */
const UNRELATED_TRANSITIONS = new Set(["typed", "address_bar", "reload", "auto_bookmark", "generated", "keyword", "keyword_generated", "auto_toplevel"]);
const STRONG_ROLES = new Set(["link", "button", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "option", "checkbox", "radio", "switch"]);
const STRONG_TAGS = new Set(["a", "button", "summary", "li"]);
const NOISE_TAGS = new Set(["html", "body", "input", "textarea", "select"]);
const DEFAULT_ATTACH_MS = 5000;

interface Visit {
  path: string;
  startSeq: number;
  nav: NavigationEvent;
  /** seq of the first navigation of the next visit (exclusive end of this visit's window) */
  endSeq: number;
}

export function isUserNavigation(nav: NavigationEvent): boolean {
  return !nav.transitionType || !UNRELATED_TRANSITIONS.has(nav.transitionType);
}

/** Clicks on the page chrome itself carry no navigation meaning. */
export function isNoiseClick(c: InteractionEvent): boolean {
  return c.kind === "click" && NOISE_TAGS.has(c.target.tag.toLowerCase());
}

/**
 * Rule 1 of the trail: map each click's seq to the path it navigated to, for clicks that a
 * user navigation followed within `attachMs` in the same tab. Shared with the route ledger.
 */
export function attachNavigations(navs: NavigationEvent[], clicks: InteractionEvent[], attachMs = DEFAULT_ATTACH_MS): Map<number, string> {
  const attached = new Map<number, string>();
  for (const nav of navs) {
    if (!isUserNavigation(nav)) continue;
    const navAt = Date.parse(nav.ts);
    for (let i = clicks.length - 1; i >= 0; i--) {
      const c = clicks[i];
      if ((c.seq ?? 0) >= (nav.seq ?? 0)) continue;
      if (c.tabId !== nav.tabId) continue;
      const dt = navAt - Date.parse(c.ts);
      if (dt < 0 || dt > attachMs) break;
      if (attached.has(c.seq ?? -1)) break;
      attached.set(c.seq ?? -1, pathnameOf(nav.url));
      break;
    }
  }
  return attached;
}

export function buildTrail(events: RecorderEvent[], anchorSeq: number, opts: TrailOptions = {}): Trail {
  const fromSeq = opts.fromSeq ?? 0;
  const attachMs = opts.attachWindowMs ?? DEFAULT_ATTACH_MS;
  const scope = events.filter((e) => (e.seq ?? 0) >= fromSeq && (e.seq ?? 0) <= anchorSeq);
  const navs = scope.filter((e): e is NavigationEvent => e.type === "navigation");
  const interactions = scope.filter(isInteractionEvent);
  const clicks = interactions.filter((e) => e.kind === "click" || e.kind === "key");

  // 1. attach navigations to the click that caused them
  const attached = attachNavigations(navs, clicks, attachMs);

  // 2. visits (reloads folded) and loop elimination
  const visits: Visit[] = [];
  for (const nav of navs) {
    const path = pathnameOf(nav.url);
    const last = visits[visits.length - 1];
    if (last && samePath(last.path, path)) continue;
    if (last) last.endSeq = nav.seq ?? last.endSeq;
    visits.push({ path, startSeq: nav.seq ?? 0, nav, endSeq: Number.MAX_SAFE_INTEGER });
  }
  const stack: Visit[] = [];
  for (const v of visits) {
    const j = stack.findIndex((s) => samePath(s.path, v.path));
    if (j >= 0) { stack.length = j; }
    stack.push(v);
  }

  // 3. hops
  let noiseClicks = 0;
  const hops: Hop[] = [];
  for (let i = 0; i < stack.length - 1; i++) {
    const v = stack[i];
    const next = visits[visits.indexOf(v) + 1];
    const windowClicks = clicks.filter((c) => (c.seq ?? 0) > v.startSeq && (c.seq ?? 0) < v.endSeq);
    const kept: TrailClick[] = [];
    for (const c of windowClicks) {
      if (isNoiseClick(c)) { noiseClicks++; continue; }
      const tc = toTrailClick(c, attached.get(c.seq ?? -1));
      const prev = kept[kept.length - 1];
      if (prev && sameTarget(prev, tc)) { if (tc.assertedNavigation && !prev.assertedNavigation) prev.assertedNavigation = tc.assertedNavigation; continue; }
      kept.push(tc);
    }
    hops.push({ from: v.path, to: stack[i + 1].path, navSeq: next?.startSeq ?? stack[i + 1].startSeq, transitionType: next?.nav.transitionType, clicks: kept });
  }

  return {
    pages: stack.map((s) => s.path),
    hops,
    dropped: { noiseClicks, inputs: interactions.filter((e) => e.kind === "input").length },
  };
}

export function toTrailClick(c: InteractionEvent, assertedNavigation: string | undefined): TrailClick {
  const t = c.target;
  const tag = t.tag.toLowerCase();
  const role = t.role ?? t.interactive?.role;
  const strong = !!t.href || (role !== undefined && STRONG_ROLES.has(role)) || STRONG_TAGS.has(tag) || !!assertedNavigation;
  const out: TrailClick = {
    seq: c.seq ?? 0,
    ts: c.ts,
    kind: c.kind === "key" ? "key" : "click",
    pageUrl: c.pageUrl,
    selectors: c.selectors ?? [],
  };
  const text = t.label ?? t.accessibleName ?? t.text;
  if (text) out.text = text;
  if (role) out.role = role;
  if (t.href) out.href = t.href;
  if (t.ancestors?.length) out.ancestors = t.ancestors;
  if (assertedNavigation) out.assertedNavigation = assertedNavigation;
  if (!strong) out.weak = true;
  return out;
}

function sameTarget(a: TrailClick, b: TrailClick): boolean {
  if (a.kind !== b.kind) return false;
  if (a.selectors[0] && b.selectors[0]) return a.selectors[0] === b.selectors[0];
  return a.text === b.text && a.role === b.role && a.href === b.href;
}

/** One-line, human-readable description of a hop for targetHint.note. */
export function describeHop(hop: Hop, appOrigin?: string): string {
  const rel = (href: string): string => {
    try { const u = new URL(href); return appOrigin && u.origin === appOrigin ? u.pathname + u.search : href; } catch { return href; }
  };
  const label = (c: TrailClick): string => {
    const t = (c.text ?? c.selectors[0] ?? "?").replace(/\s+/g, " ");
    return t.length > 30 ? `${t.slice(0, 30)}…` : t;
  };
  const parts = hop.clicks.map((c) => {
    const bits: string[] = [];
    if (c.role) bits.push(c.role);
    if (c.href) bits.push(`href ${rel(c.href)}`);
    if (c.weak) bits.push("weak");
    const verb = c.kind === "key" ? "Enter" : "點";
    return `${verb}「${label(c)}」${bits.length ? `(${bits.join(", ")})` : ""}`;
  });
  return `在 ${hop.from}：${parts.join(" → ")} → 進入 ${hop.to}`;
}
