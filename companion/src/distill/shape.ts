import type { NavigationEvent, RecorderEvent, RequestEvent } from "../types.js";
import { isRequestEvent } from "../types.js";
import type { ExistingDataRef, RecipeShape } from "../recipe.js";
import { leavesOf, urlLeaves } from "./leaves.js";
import { routeSegments } from "../util/route.js";

export interface ShapeInput {
  /** the whole claimed range, in order */
  events: RecorderEvent[];
  /** what Layer 2a + 2b decided to keep */
  kept: RequestEvent[];
  anchor: NavigationEvent;
  targetUrl: string;
  /** the navigation before the anchor — everything before it is treated as site-wide context */
  previousPage?: NavigationEvent;
  /** read-only requests the target page issued (from reachability) */
  targetWindowReads: RequestEvent[];
  /** the recorded login response, whose values (user id, tenant id…) travel with every page */
  authEvent?: RequestEvent;
  /** how to name a request in the refs, e.g. "POST Apps/AppDetail" */
  show: (r: RequestEvent) => string;
}

export interface ShapeResult {
  shape: RecipeShape;
  existingDataRefs: ExistingDataRef[];
}

const MAX_REFS = 8;

/**
 * Classify what a distilled recording actually is.
 *
 * Steps decide the easy case: anything kept means the recipe builds state (`data`). The interesting
 * split is between the two zero-step cases. A recording that only walked through menus produces a
 * recipe that works anywhere; one where the user opened *a particular record* produces a recipe that
 * silently depends on that record still being in the database — it looks identical (zero steps) but
 * fails on a fresh environment, so it has to be named differently.
 *
 * The evidence for "a particular record" is a value that the target screen asked for and that was
 * handed to the user by an earlier response (a list they picked from). Values that merely travel
 * with the session — ids minted at login, anything already in flight before the previous page — are
 * subtracted: they identify the user, not the record.
 */
export function classifyShape(input: ShapeInput): ShapeResult {
  if (input.kept.length > 0) return { shape: "data", existingDataRefs: [] };

  const { events, anchor, targetWindowReads, previousPage, authEvent, show } = input;
  const anchorSeq = anchor.seq ?? Number.MAX_SAFE_INTEGER;

  // What the target screen asked for: its own request values, plus identifiers carried in the URL
  // it was reached by (path segments of the route itself are the route, not data).
  const routeOwnSegments = new Set(routeSegments(input.targetUrl).map((s) => s.toLowerCase()));
  const inputs = new Map<string, string>(); // value → the request that used it
  for (const r of targetWindowReads) {
    const label = show(r);
    for (const l of leavesOf(r.requestBody)) if (!inputs.has(l.value)) inputs.set(l.value, label);
    for (const l of urlLeaves(r.url)) if (!inputs.has(l.value)) inputs.set(l.value, label);
  }
  for (const l of urlLeaves(anchor.url)) {
    if (routeOwnSegments.has(l.value.toLowerCase())) continue;
    if (!inputs.has(l.value)) inputs.set(l.value, `navigation to ${anchor.url}`);
  }
  if (inputs.size === 0) return { shape: "navigation", existingDataRefs: [] };

  // Values the app handed to the user before they arrived: responses of earlier requests.
  const priorResponses = new Map<string, string>(); // value → the response that produced it
  for (const ev of events) {
    if (!isRequestEvent(ev) || (ev.seq ?? 0) >= anchorSeq) continue;
    if (authEvent && ev.requestId === authEvent.requestId) continue;
    const label = show(ev);
    for (const l of leavesOf(ev.responseBody)) if (!priorResponses.has(l.value)) priorResponses.set(l.value, label);
  }

  // Session-wide context: everything the client was already sending before the previous page, plus
  // whatever login returned. These recur on every screen and identify nobody's record.
  const contextBoundary = previousPage?.seq ?? 0;
  const context = new Set<string>();
  for (const ev of events) {
    if (!isRequestEvent(ev)) continue;
    if ((ev.seq ?? 0) >= contextBoundary) continue;
    for (const l of leavesOf(ev.requestBody)) context.add(l.value);
    for (const l of urlLeaves(ev.url)) context.add(l.value);
  }
  if (authEvent) {
    for (const l of leavesOf(authEvent.responseBody)) context.add(l.value);
    for (const l of leavesOf(authEvent.requestBody)) context.add(l.value);
  }

  const existingDataRefs: ExistingDataRef[] = [];
  for (const [value, usedBy] of inputs) {
    if (context.has(value)) continue;
    const seenIn = priorResponses.get(value);
    if (!seenIn) continue;
    existingDataRefs.push({ value, usedBy, seenIn });
    if (existingDataRefs.length >= MAX_REFS) break;
  }
  return existingDataRefs.length
    ? { shape: "navigation-existing-data", existingDataRefs }
    : { shape: "navigation", existingDataRefs: [] };
}
