import type { RecorderEvent } from "../types.js";
import { pathnameOf } from "../execute/urls.js";
import { samePath } from "./layer2aReachability.js";

/**
 * A browsing session inside a claimed range, detected mechanically at read time (the on-disk
 * format is untouched). capture-recent distils only the session that reached the target (see
 * taskStartIndex) and still claims the others, naming what it left out.
 */
export interface Segment {
  index: number;
  fromSeq: number;
  toSeq: number;
  startedAt: string;
  endedAt: string;
  tabIds: number[];
  /** why this segment started */
  reason: "start" | "gap" | "newTab" | "login";
  /** distinct navigation paths, in order, at most 10 */
  navigations: string[];
  requests: number;
}

export interface SegmentOptions {
  /** idle gap (minutes) between consecutive events that starts a new segment */
  gapMinutes: number;
  /** login page path (config.login.url); a navigation to it starts a new segment */
  loginPath?: string;
}

const MAX_NAVS = 10;

function at(ev: RecorderEvent): string {
  return ev.receivedAt ?? ev.ts;
}

export function segmentEvents(events: RecorderEvent[], opts: SegmentOptions): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | undefined;
  let prev: RecorderEvent | undefined;
  const gapMs = Math.max(0, opts.gapMinutes) * 60_000;

  const open = (ev: RecorderEvent, reason: Segment["reason"]): Segment => {
    const seg: Segment = { index: out.length, fromSeq: ev.seq ?? 0, toSeq: ev.seq ?? 0, startedAt: at(ev), endedAt: at(ev), tabIds: [], reason, navigations: [], requests: 0 };
    out.push(seg);
    return seg;
  };

  for (const ev of events) {
    let reason: Segment["reason"] | undefined;
    if (!cur) reason = "start";
    else if (prev && gapMs > 0 && Date.parse(at(ev)) - Date.parse(at(prev)) >= gapMs) reason = "gap";
    else if (ev.type === "navigation" && ev.transition === "committed" && !cur.tabIds.includes(ev.tabId)) reason = "newTab";
    else if (ev.type === "navigation" && opts.loginPath && samePath(ev.url, opts.loginPath)) reason = "login";

    // A boundary while the current segment has no request yet is just the app booting
    // ("/" → "/Login"): extend instead of cutting a navigation-only sliver.
    if (reason && reason !== "start" && cur && cur.requests === 0) reason = undefined;
    if (reason) cur = open(ev, reason);
    const seg = cur!;

    seg.toSeq = ev.seq ?? seg.toSeq;
    seg.endedAt = at(ev);
    if (!seg.tabIds.includes(ev.tabId)) seg.tabIds.push(ev.tabId);
    if (ev.type === "navigation") {
      const path = pathnameOf(ev.url);
      if (!seg.navigations.includes(path) && seg.navigations.length < MAX_NAVS) seg.navigations.push(path);
    } else {
      seg.requests++;
    }
    prev = ev;
  }
  return out;
}

/** Index of the segment containing `seq`, or -1. */
export function segmentIndexOf(segments: Segment[], seq: number): number {
  return segments.findIndex((s) => seq >= s.fromSeq && seq <= s.toSeq);
}

/**
 * First segment of the task that reached the target. "login" boundaries are walked back over: inside
 * one tab they are usually a role switch or an expired session within the same task. A new tab, an
 * idle gap or the start of the range ends the walk.
 */
export function taskStartIndex(segments: Segment[], anchorIdx: number): number {
  let i = anchorIdx;
  while (i > 0 && segments[i].reason === "login") i--;
  return i;
}

/** Events recorded after the session that reached the target are claimed but never part of the recipe. */
export function trailingSegmentWarning(segments: Segment[], anchorSeq: number): string | undefined {
  const anchorIdx = segmentIndexOf(segments, anchorSeq);
  if (anchorIdx < 0 || anchorIdx >= segments.length - 1) return undefined;
  return `The target page was last reached in session ${anchorIdx + 1} of ${segments.length}; everything recorded afterwards (seq > ${segments[anchorIdx].toSeq}) is outside the recipe.`;
}

/** Human-readable hints when a claimed range distilled whole spans more than one browsing session. */
export function segmentWarnings(segments: Segment[], anchorSeq: number): string[] {
  if (segments.length <= 1) return [];
  const reasons = [...new Set(segments.slice(1).map((s) => s.reason))].join("/");
  const warnings = [
    `Claimed range spans ${segments.length} browsing sessions (boundaries: ${reasons}). If an earlier session is unrelated to this task, re-run with --from-seq <that session's fromSeq - 1>; if a boundary is "login" it may be a role switch inside one task — check whether the earlier session contributed kept steps before dropping it.`,
  ];
  const trailing = trailingSegmentWarning(segments, anchorSeq);
  if (trailing) warnings.push(trailing);
  return warnings;
}
