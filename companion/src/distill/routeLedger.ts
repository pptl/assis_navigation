import type { InteractionEvent, NavigationEvent, RecorderEvent } from "../types.js";
import { isInteractionEvent } from "../types.js";
import { pathnameOf } from "../execute/urls.js";
import { normRoute } from "../util/route.js";
import { samePath } from "./layer2aReachability.js";
import { attachNavigations, isNoiseClick, toTrailClick } from "./trail.js";

/**
 * Route ledger: what the recording actually visited, and what was clicked on the way in.
 *
 * This is the mechanical answer to "which screen was the user on when they described the task" —
 * the question Agent dev currently answers by re-reading the project's router / menu / permission
 * config on every task. Unlike `buildTrail`, nothing is folded away: a detour visited once still
 * gets its own row, because the user may well have been describing that screen.
 */

export interface LedgerClick {
  text?: string;
  role?: string;
  href?: string;
  /** the route the click happened on */
  fromRoute: string;
  /** target had no navigation semantics — could be noise, could be a menu item in a div */
  weak?: boolean;
}

export interface LedgerRoute {
  route: string;
  visits: number;
  firstSeq: number;
  lastSeq: number;
  firstAt: string;
  lastAt: string;
  /** click labels recorded between the previous page and this one, most recent visit first */
  enteredBy: LedgerClick[];
}

export interface LedgerOptions {
  /** a navigation is attached to a click at most this long before it */
  attachWindowMs?: number;
  /** clicks kept per route */
  maxClicksPerRoute?: number;
}

interface Visit {
  path: string;
  navSeq: number;
  at: string;
  /** navSeq of the previous visit — the window in which the entering clicks happened */
  fromSeq: number;
  fromRoute: string;
}

const MAX_CLICKS = 5;

function at(ev: RecorderEvent): string {
  return ev.receivedAt ?? ev.ts;
}

/** Consecutive navigations to the same path (reloads, in-page history churn) are one visit. */
function visitsOf(navs: NavigationEvent[]): Visit[] {
  const out: Visit[] = [];
  for (const nav of navs) {
    const path = pathnameOf(nav.url);
    const last = out[out.length - 1];
    if (last && samePath(last.path, path)) continue;
    out.push({ path, navSeq: nav.seq ?? 0, at: at(nav), fromSeq: last?.navSeq ?? -1, fromRoute: last?.path ?? "" });
  }
  return out;
}

export function routeLedger(events: RecorderEvent[], opts: LedgerOptions = {}): LedgerRoute[] {
  const maxClicks = opts.maxClicksPerRoute ?? MAX_CLICKS;
  const navs = events.filter((e): e is NavigationEvent => e.type === "navigation");
  const clicks = events.filter(isInteractionEvent).filter((e) => e.kind === "click" || e.kind === "key");
  const attached = attachNavigations(navs, clicks, opts.attachWindowMs);
  const visits = visitsOf(navs);

  const byRoute = new Map<string, LedgerRoute>();
  for (const v of visits) {
    const key = normRoute(v.path);
    const existing = byRoute.get(key);
    const row: LedgerRoute = existing ?? {
      route: key,
      visits: 0,
      firstSeq: v.navSeq,
      lastSeq: v.navSeq,
      firstAt: v.at,
      lastAt: v.at,
      enteredBy: [],
    };
    row.visits++;
    if (v.navSeq < row.firstSeq) { row.firstSeq = v.navSeq; row.firstAt = v.at; }
    if (v.navSeq > row.lastSeq) { row.lastSeq = v.navSeq; row.lastAt = v.at; }
    // Clicks between the previous page and this one are the way in. The tab switch that had to
    // happen first (a top-nav tab) sits in the same window as the menu item that actually navigated, so
    // taking the whole window — not just the click the navigation attached to — is the point.
    for (const c of enteringClicks(clicks, v, attached)) {
      if (row.enteredBy.length >= maxClicks) break;
      if (row.enteredBy.some((x) => x.text === c.text && x.role === c.role && x.fromRoute === c.fromRoute)) continue;
      row.enteredBy.push(c);
    }
    byRoute.set(key, row);
  }

  return [...byRoute.values()].sort((a, b) => b.lastSeq - a.lastSeq);
}

function enteringClicks(clicks: InteractionEvent[], v: Visit, attached: Map<number, string>): LedgerClick[] {
  if (v.fromSeq < 0) return [];
  const out: LedgerClick[] = [];
  for (const c of clicks) {
    const seq = c.seq ?? 0;
    if (seq <= v.fromSeq || seq >= v.navSeq) continue;
    if (isNoiseClick(c)) continue;
    const tc = toTrailClick(c, attached.get(seq));
    const one: LedgerClick = { fromRoute: v.fromRoute };
    if (tc.text) one.text = tc.text;
    if (tc.role) one.role = tc.role;
    if (tc.href) one.href = tc.href;
    if (tc.weak) one.weak = true;
    out.push(one);
  }
  return out;
}
