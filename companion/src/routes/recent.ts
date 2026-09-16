import type { NavConfig, RecorderEvent } from "../types.js";
import { readEvents } from "../store/raw.js";
import { loadClaimState } from "../store/claimState.js";
import { loadRouteCatalogue, type RouteObservation, type RoutePlacement } from "../store/routeCatalogue.js";
import { routeLedger, type LedgerRoute } from "../distill/routeLedger.js";
import { segmentEvents, segmentIndexOf, type Segment } from "../distill/segments.js";

/**
 * "Where has the user just been?" — the route ledger of a recording, joined with whatever the
 * catalogue already knows about each route. This is what Agent dev reads instead of re-deriving
 * paths from the project's router / menu / permission config on every task.
 */

export interface RouteCandidate extends LedgerRoute {
  /** names the catalogue has for this route (empty when it has never been named) */
  names: string[];
  placements: RoutePlacement[];
  /** whether the catalogue already knew this route */
  known: boolean;
}

export interface RecentRoutes {
  fromSeq: number;
  toSeq: number;
  events: number;
  routes: RecentRoute[];
  segments: Segment[];
}

export interface RecentRoute extends RouteCandidate {
  /** index into `segments` of the browsing session this route was last visited in — the last session is where the user is now */
  segment: number;
}

/** Join a recording's ledger with the catalogue. */
export function annotateLedger(dataDir: string, events: RecorderEvent[]): RouteCandidate[] {
  const catalogue = loadRouteCatalogue(dataDir);
  const byLower = new Map(Object.entries(catalogue.entries).map(([k, v]) => [k.toLowerCase(), v] as const));
  return routeLedger(events).map((r) => {
    const entry = byLower.get(r.route.toLowerCase());
    return { ...r, names: entry?.names ?? [], placements: entry?.placements ?? [], known: !!entry };
  });
}

export function recentRoutes(dataDir: string, cfg: NavConfig, fromSeqOverride?: number): RecentRoutes {
  const claim = loadClaimState(dataDir);
  const fromSeq = fromSeqOverride ?? claim.lastSeq;
  const events = readEvents(dataDir, { afterSeq: fromSeq });
  const last = events[events.length - 1];
  const segments = segmentEvents(events, { gapMinutes: cfg.recording.sessionGapMinutes, loginPath: cfg.login.kind === "ui" ? cfg.login.url : undefined });
  return {
    fromSeq,
    toSeq: last?.seq ?? fromSeq,
    events: events.length,
    routes: annotateLedger(dataDir, events).map((r) => ({ ...r, segment: segmentIndexOf(segments, r.lastSeq) })),
    segments,
  };
}

/**
 * Turn a recording's ledger into catalogue observations. Names are deliberately not invented here —
 * a path and a click label are mechanical facts; deciding that "產生訂單" names this screen is
 * Agent dev's judgement, written back with `routes set`.
 */
export function observationsFrom(routes: LedgerRoute[], recipeName: string): { route: string; obs: RouteObservation }[] {
  return routes.map((r) => ({
    route: r.route,
    obs: {
      source: "observed" as const,
      seen: r.visits,
      enteredBy: r.enteredBy.map((c) => c.text).filter((t): t is string => !!t),
      evidence: `visited ${r.visits}× in the recording distilled into ${recipeName}`,
    },
  }));
}
