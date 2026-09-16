import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ActorsFile, NavConfig, RecorderEvent, RequestEvent } from "../types.js";
import { isRequestEvent } from "../types.js";
import { CliError } from "../errors.js";
import { p, projectDirOf } from "../paths.js";
import { claimsDir, readEvents, readMeta, writeEventFile } from "../store/raw.js";
import { advanceClaim, loadClaimState } from "../store/claimState.js";
import { recipePath, saveRecipe } from "../store/recipes.js";
import { recordRoutes } from "../store/routeCatalogue.js";
import { writeReadme } from "../store/readme.js";
import { annotateLedger, observationsFrom } from "../routes/recent.js";
import { routeLedger } from "./routeLedger.js";
import { readJson } from "../util/fs.js";
import { makeReadOnlyClassifier } from "./layer1ReadOnly.js";
import { reachability, type ReachabilityResult } from "./layer2aReachability.js";
import { createProviders } from "./schemaEvidence/index.js";
import { buildDraft } from "./draftBuilder.js";
import { pathnameOf, relativeToApiBase } from "../execute/urls.js";
import { leavesOf } from "./leaves.js";
import { segmentEvents, segmentIndexOf, segmentWarnings, taskStartIndex, trailingSegmentWarning, type Segment } from "./segments.js";
import { buildTrail, describeHop, type Trail } from "./trail.js";
import { classifyShape } from "./shape.js";
import { effectiveEntry, loadDataSourceMap, type EffectiveEntry } from "../store/dataSourceMap.js";
import type { ExistingDataRef, PendingDecision, RecipeShape, TargetHintClick } from "../recipe.js";

export interface CaptureOptions {
  description: string;
  targetUrl: string;
  actor?: string;
  /** override the claim start (default: after the last claim). An explicit start is distilled whole — no narrowing to the target's session. */
  fromSeq?: number;
  /** distil the whole claimed range instead of only the browsing session that reached the target */
  all?: boolean;
  /** analyse only; do not write the recipe or advance the claim */
  dryRun?: boolean;
}

/** Which part of the claimed range became the recipe. */
export interface CaptureScope {
  /** "session": only the browsing session that reached the target (default); "range": the whole claimed range (--all / --from-seq) */
  mode: "session" | "range";
  /** first seq distilled */
  fromSeq: number;
  events: number;
  /** indexes into `segments` of earlier sessions that were claimed but not distilled */
  excludedSegments: number[];
  /** requests that distilling the whole range would have kept as steps, found in the excluded sessions ("POST Apps/AppCreate (seq 8)") */
  excludedWouldKeep: string[];
}

export interface CaptureResult {
  recipeName: string;
  recipeFile: string | null;
  draft: true;
  selfVerification: "pending";
  /** what the claim pointer moved over: everything since the last claim, distilled or not */
  claimedRange: { from: string; to: string; fromSeq: number; toSeq: number; events: number };
  scope: CaptureScope;
  /** browsing sessions detected inside the claimed range */
  segments: Segment[];
  /** 0-based index into `segments` of the session that reached the target page */
  anchorSegment: number;
  warnings: string[];
  anchor: { seq: number; url: string };
  finalNavigationGuess: string;
  /** how the guessed finalNavigation must be entered (route override, else the site default) */
  finalNavigationEntry: EffectiveEntry;
  /** what kind of preparation this is — decides which pendingDecisions matter and what to verify */
  shape: RecipeShape;
  /** shape "navigation-existing-data" only: records the recipe assumes already exist */
  existingDataRefs: ExistingDataRef[];
  targetHint: { url: string; note?: string };
  /** navigation path assembled from navigations + recorded clicks (the anchor's browsing segment only) */
  path: Trail;
  evidence: {
    kept: { stepId: string; requestId: string; method: string; url: string; reason: string[] }[];
    dropped: { readOnly: number; unreachable: string[]; failed: string[]; afterAnchor: string[]; authRefresh: string[] };
    authRequest?: { requestId: string; method: string; url: string };
    schemaProviders: { kind: string; size: number }[];
  };
  pendingDecisions: PendingDecision[];
  probeRecommended: boolean;
  stats: { steps: number; params: number; captured: number; codeEvidence: number; shape: RecipeShape };
  /** routes this recording contributed to the route catalogue (source: observed) */
  routesLearned: string[];
}

const USERNAME_KEYS = /^(user(_?name)?|account|login|email|user_?id|loginid|acct)$/i;

/** Best-effort username from a recorded login request body (JSON or form-encoded). */
export function loginUsername(ev: RequestEvent): string | undefined {
  const body = ev.requestBody;
  if (!body) return undefined;
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    if (j && typeof j === "object") {
      const key = Object.keys(j).find((k) => USERNAME_KEYS.test(k));
      if (key && typeof j[key] === "string") return j[key] as string;
    }
  } catch { /* not JSON */ }
  try {
    const params = new URLSearchParams(body);
    for (const [k, v] of params) if (USERNAME_KEYS.test(k)) return v;
  } catch { /* ignore */ }
  return undefined;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "recipe";
}

function dateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export function uniqueRecipeName(dataDir: string, base: string): string {
  let name = base;
  for (let i = 2; existsSync(recipePath(dataDir, name)); i++) name = `${base}-${i}`;
  return name;
}

export function discardRecent(dataDir: string): { discarded: number; fromSeq: number; toSeq: number; lastClaimedAt: string | null } {
  const claim = loadClaimState(dataDir);
  const meta = readMeta(dataDir);
  const state = advanceClaim(dataDir, { recipeName: null, fromSeq: claim.lastSeq, toSeq: meta.lastSeq, events: meta.lastSeq - claim.lastSeq, discarded: true });
  return { discarded: Math.max(0, meta.lastSeq - claim.lastSeq), fromSeq: claim.lastSeq, toSeq: meta.lastSeq, lastClaimedAt: state.lastClaimedAt };
}

interface Selection {
  reach: ReachabilityResult;
  requests: RequestEvent[];
  isLogin: (r: RequestEvent) => boolean;
  /** logins before the anchor, in order */
  loginEvents: RequestEvent[];
  authEvent?: RequestEvent;
  authRefresh: RequestEvent[];
  keptMap: Map<string, RequestEvent>;
  kept: RequestEvent[];
  reasons: Record<string, string[]>;
}

/** Layers 1–2b over one slice of the recording: which requests become steps, and why. */
function selectRequests(events: RecorderEvent[], cfg: NavConfig, targetUrl: string, isReadOnly: (ev: RequestEvent) => boolean): Selection {
  const reach = reachability(events, targetUrl, isReadOnly);
  const anchorSeq = reach.anchor.seq ?? 0;
  const requests = events.filter(isRequestEvent);

  // Layer 2b: producers referenced by any request in range (before the anchor).
  const byId = new Map(requests.map((r) => [r.requestId, r] as const));
  const sourceIds = new Set<string>();
  for (const r of requests) for (const s of r.authSources ?? []) sourceIds.add(s);
  const producers2b = [...sourceIds].map((id) => byId.get(id)).filter((r): r is RequestEvent => !!r && (r.seq ?? 0) < anchorSeq);

  const loginCall = cfg.login.call;
  const isLogin = (r: RequestEvent): boolean => {
    if (loginCall) {
      const rel = relativeToApiBase(cfg, r.url).url.split("?")[0].replace(/^\/+|\/+$/g, "").toLowerCase();
      const want = loginCall.url.replace(/^\/+|\/+$/g, "").toLowerCase();
      if (r.method.toUpperCase() === loginCall.method.toUpperCase() && (rel === want || rel.endsWith(`/${want}`))) return true;
    }
    const hasAuth = Object.keys(r.requestHeaders).some((k) => k.toLowerCase() === "authorization");
    return sourceIds.has(r.requestId) && !hasAuth && r.status < 400;
  };
  const loginEvents = requests.filter((r) => isLogin(r) && (r.seq ?? 0) < anchorSeq);
  const authEvent = loginEvents[loginEvents.length - 1];

  // A producer that was itself authenticated (it ran on a token/cookie minted earlier) and carries no
  // data of its own is a token *refresh* (e.g. an `auth/check` endpoint returning a rotated JWT on every
  // call), not an origin of the auth chain: ensureContext's login covers it, so it must not become a
  // step. Residual risk: a context switch whose only parameter lives in a path segment (POST
  // /tenant/{id}/switch with an empty body) is dropped too — it is listed in dropped.authRefresh so the
  // Agent can add it back by hand.
  const isAuthRefresh = (r: RequestEvent): boolean => {
    if (isLogin(r)) return false;
    const authenticated = Object.keys(r.requestHeaders).some((k) => k.toLowerCase() === "authorization") || (r.authSources?.length ?? 0) > 0;
    if (!authenticated) return false;
    if (relativeToApiBase(cfg, r.url).url.includes("?")) return false;
    return leavesOf(r.requestBody).length === 0;
  };
  const authRefresh = producers2b.filter(isAuthRefresh);
  const kept2b = producers2b.filter((r) => !isAuthRefresh(r));

  const keptMap = new Map<string, RequestEvent>();
  for (const r of [...reach.kept, ...kept2b]) if (!isLogin(r)) keptMap.set(r.requestId, r);
  const kept = [...keptMap.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const reasons: Record<string, string[]> = { ...reach.reasons };
  for (const r of kept2b) reasons[r.requestId] = [...(reasons[r.requestId] ?? []), "auth artefact referenced later (Layer 2b)"];
  return { reach, requests, isLogin, loginEvents, authEvent, authRefresh, keptMap, kept, reasons };
}

export function captureRecent(dataDir: string, cfg: NavConfig, opts: CaptureOptions): CaptureResult {
  const claim = loadClaimState(dataDir);
  const fromSeq = opts.fromSeq ?? claim.lastSeq;
  const events = readEvents(dataDir, { afterSeq: fromSeq });
  if (!events.length) throw new CliError("E_NO_EVENTS", `No recorded events after seq ${fromSeq}. Is the extension loaded and the origin registered? (nav-recorder doctor)`);

  const isReadOnly = makeReadOnlyClassifier(cfg);
  const segments = segmentEvents(events, { gapMinutes: cfg.recording.sessionGapMinutes, loginPath: cfg.login.kind === "ui" ? cfg.login.url : undefined });
  let whole: Selection;
  try {
    whole = selectRequests(events, cfg, opts.targetUrl, isReadOnly);
  } catch (e) {
    if (e instanceof CliError && e.code === "E_NO_ANCHOR") {
      // Hand back the full ledger, not just a list of paths: the route the user meant is in here,
      // named and placed in the menu whenever the catalogue already knows it.
      throw new CliError(e.code, e.message, { ...(e.details as Record<string, unknown> ?? {}), segments, routes: annotateLedger(dataDir, events) });
    }
    throw e;
  }
  const anchorSeq = whole.reach.anchor.seq ?? 0;
  const anchorSegment = segmentIndexOf(segments, anchorSeq);

  // The claimed range is "everything since the last claim". On a day of several tasks — small ones
  // often never claim anything — it spans unrelated browsing sessions whose requests share values
  // with this one (the same user, the same master data) and get pulled in by value flow. Distil only
  // the session that reached the target; the earlier ones are still claimed, and any step they would
  // have contributed is named (excludedWouldKeep) so leaving it out is a decision, not an accident.
  // An explicit --from-seq or --all means the caller chose the range: distil it whole.
  const mode: CaptureScope["mode"] = opts.all || opts.fromSeq !== undefined ? "range" : "session";
  const startIdx = mode === "session" && anchorSegment > 0 ? taskStartIndex(segments, anchorSegment) : 0;
  const scoped = startIdx > 0 ? events.filter((ev) => (ev.seq ?? 0) >= segments[startIdx].fromSeq) : events;
  const scopeFromSeq = scoped[0].seq ?? fromSeq + 1;
  const sel = startIdx > 0 ? selectRequests(scoped, cfg, opts.targetUrl, isReadOnly) : whole;
  const { reach, requests, isLogin, keptMap, kept, reasons, authRefresh } = sel;
  // Who was logged in: this session's own login, else the last one before it (an idle gap after logging in is common).
  const loginEvents = sel.loginEvents.length ? sel.loginEvents : whole.loginEvents.slice(-1);
  const authEvent = sel.authEvent ?? whole.authEvent;
  const excludedWouldKeep = startIdx > 0 ? whole.kept.filter((r) => (r.seq ?? 0) < scopeFromSeq) : [];
  const show = (r: RequestEvent): string => `${r.method} ${relativeToApiBase(cfg, r.url).url}`;

  const warnings: string[] = [];
  if (startIdx > 0) {
    const sessions = anchorSegment > startIdx ? `sessions ${startIdx + 1}–${anchorSegment + 1}` : `session ${anchorSegment + 1}`;
    warnings.push(`Claimed range spans ${segments.length} browsing sessions; only the one that reached the target was distilled (${sessions} of ${segments.length}, seq >= ${scopeFromSeq}). The ${startIdx} earlier session(s) are claimed but not distilled (scope.excludedSegments)${excludedWouldKeep.length ? `, and they hold ${excludedWouldKeep.length} request(s) the whole range would have kept — see the excludedSteps decision` : ""}.`);
    const trailing = trailingSegmentWarning(segments, anchorSeq);
    if (trailing) warnings.push(trailing);
  } else {
    warnings.push(...segmentWarnings(segments, anchorSeq));
  }

  const actorsFile = p(dataDir, "actors.json");
  const actors = existsSync(actorsFile) ? readJson<ActorsFile>(actorsFile, { actors: {} }) : { actors: {} };
  const actorNames = Object.keys(actors.actors ?? {});
  const defaultActor = opts.actor ?? actorNames[0] ?? "employee";

  const projectDir = projectDirOf(dataDir);
  const providers = createProviders(cfg, projectDir);
  const base = `${slugify(pathnameOf(opts.targetUrl))}-${dateStamp()}`;
  const recipeName = uniqueRecipeName(dataDir, base);
  const at = (ev: RecorderEvent): string => ev.receivedAt ?? ev.ts;
  const last = events[events.length - 1];
  const distilledRange = { from: at(scoped[0]), to: at(scoped[scoped.length - 1]) };
  const rawClaimFile = join(claimsDir(dataDir), `${recipeName}.ndjson`);

  const draft = buildDraft({
    cfg, recipeName, description: opts.description, targetUrl: opts.targetUrl, kept, authEvent,
    previousPage: reach.previousPage, providers, defaultActor, actorNames, claimedRange: distilledRange, anchorSeq,
    rawClaimFile: opts.dryRun ? undefined : rawClaimFile,
  });
  for (const step of draft.recipe.steps) {
    const ev = kept.find((r) => step.note?.includes(r.requestId));
    if (ev && reasons[ev.requestId]) step.note = `${step.note} — kept because: ${reasons[ev.requestId].join("; ")}`;
  }

  // Path assembly from navigations + recorded clicks. The last hop is the way from finalNavigation
  // into the target — pre-fill targetHint with it so the Agent does not have to rediscover it.
  const segmentStart = anchorSegment >= 0 ? segments[anchorSegment].fromSeq : 0;
  const trail = buildTrail(events, anchorSeq, { fromSeq: segmentStart });
  const lastHop = trail.hops[trail.hops.length - 1];
  if (lastHop && lastHop.clicks.length && draft.recipe.targetHint) {
    draft.recipe.targetHint.note = describeHop(lastHop, cfg.appOrigins[0]);
    draft.recipe.targetHint.clicks = lastHop.clicks.map((c) => {
      const out: TargetHintClick = { selectors: c.selectors };
      if (c.text) out.text = c.text;
      if (c.role) out.role = c.role;
      if (c.href) out.href = c.href;
      if (c.weak) out.weak = true;
      return out;
    });
    const decision = draft.recipe.pendingDecisions?.find((d) => d.kind === "confirmTargetHint");
    if (decision) decision.message = `targetHint.note/clicks were pre-filled from ${lastHop.clicks.length} recorded click(s) on ${lastHop.from}. Check they describe the last hop into the target (drop clicks marked weak that are not needed); rewrite only if wrong.`;
  }
  if (trail.pages.length >= 2) {
    const beforeTarget = trail.pages[trail.pages.length - 2];
    const guess = pathnameOf(draft.recipe.finalNavigation);
    if (beforeTarget.toLowerCase() !== guess.toLowerCase()) {
      warnings.push(`After folding detours, the page before the target is ${beforeTarget}, but finalNavigation was guessed as ${guess} (the navigation right before the anchor). Pick the one that is a stable page the change will not touch.`);
    }
  }

  // What kind of preparation this is, and how its last stable page has to be entered. Both are
  // mechanical facts the Agent would otherwise have to re-derive (or guess) every task.
  const { shape, existingDataRefs } = classifyShape({
    events: scoped, kept, anchor: reach.anchor, targetUrl: opts.targetUrl, previousPage: reach.previousPage,
    targetWindowReads: reach.targetWindowReads, authEvent, show,
  });
  draft.recipe.shape = shape;
  if (existingDataRefs.length) draft.recipe.existingDataRefs = existingDataRefs;

  const dsMap = loadDataSourceMap(dataDir);
  const finalNavigationEntry = effectiveEntry(cfg, dsMap, draft.recipe.finalNavigation);
  // Annotate the candidate stable pages with how each has to be entered, so the choice is made on
  // evidence rather than on the Agent's memory of this project.
  const finalDecision = draft.recipe.pendingDecisions?.find((d) => d.kind === "confirmFinalNavigation");
  if (finalDecision && Array.isArray(finalDecision.options)) {
    finalDecision.options = finalDecision.options.map((o) => {
      const path = String(o);
      const eff = effectiveEntry(cfg, dsMap, path);
      return { path, entry: eff.entry, entryFrom: eff.from };
    });
    finalDecision.message += " Each option is annotated with how it has to be entered: prefer one whose entry is \"deeplink\"; picking a \"menu\" one means the menu hops belong in targetHint.";
  }
  if (finalNavigationEntry.entry === "menu") {
    warnings.push(`finalNavigation ${draft.recipe.finalNavigation} must be entered through the app's own navigation (${finalNavigationEntry.from === "route" ? "recorded for this route in data-source-map" : "site default, config.navigation"}): navigating straight to it can land on a blank screen. Either pick a stable page known to work by deep link (the login landing page is the usual one) and move the menu hops into targetHint, or keep it and walk the menu on handover.`);
  } else if (finalNavigationEntry.entry === "unknown") {
    warnings.push(`How screens are entered in this project was never established (config.navigation.entry is "unknown"), so nothing is known about ${draft.recipe.finalNavigation}. Navigate to it once in a fresh session, then record the result with \`nav-recorder data-source set\` and ask the user to set config.navigation.`);
  }
  if (shape !== "data") {
    warnings.push(`shape is "${shape}": there are no API steps, so the only things that can break are the last hop and the landing check. verify is empty — fill it with a stable element of finalNavigation (avoiding anything this change will touch) before clearing the draft flag.`);
  }
  if (existingDataRefs.length) {
    draft.recipe.pendingDecisions ??= [];
    draft.recipe.pendingDecisions.unshift({
      kind: "existingData",
      message: `The target screen used ${existingDataRefs.map((r) => `"${r.value}" (${r.usedBy}, first seen in ${r.seenIn})`).join(", ")}, and no step in this recipe creates it. As it stands the recipe assumes that record is already in the test database — fine on this machine, silently broken on a fresh one. Either confirm the assumption (keep existingDataRefs and say so in the description), or add an api step that creates it (the shape becomes "data" on save).`,
      options: existingDataRefs,
    });
  }
  if (excludedWouldKeep.length) {
    const listed = excludedWouldKeep.map((r) => `${show(r)} (seq ${r.seq})`);
    draft.recipe.pendingDecisions ??= [];
    draft.recipe.pendingDecisions.unshift({
      kind: "excludedSteps",
      message: `Only the browsing session that reached the target was distilled. Distilling the whole claimed range would also keep ${listed.join(", ")}, recorded in earlier session(s). If they prepare this task — they create the record the target screen shows, or the task switched roles in another tab — re-run \`nav-recorder capture-recent "<same description>" --target-url ${pathnameOf(opts.targetUrl)} --from-seq ${fromSeq}\` (an explicit range is distilled whole) and delete this draft. If they belong to another task, drop this decision.`,
      options: listed,
    });
  }

  // New-actor detection: a login in the recording with a username actors.json does not know.
  const knownUsers = new Set(Object.values(actors.actors ?? {}).map((a) => a.username));
  const seenUsers = [...new Set(loginEvents.map(loginUsername).filter((u): u is string => !!u))];
  const unknownUsers = seenUsers.filter((u) => !knownUsers.has(u));
  if (unknownUsers.length) {
    draft.recipe.pendingDecisions ??= [];
    draft.recipe.pendingDecisions.unshift({
      kind: "newActor",
      message: `The recording logged in as ${unknownUsers.map((u) => `"${u}"`).join(", ")}, which actors.json does not list. Ask the user which role each account plays, have them add it (with password) to actors.json, then set that role as the actor of the affected steps.`,
      options: unknownUsers,
    });
  }

  // Every claimed recording teaches the catalogue which routes exist and how they were entered.
  // This is the cheap half of the knowledge: no Agent effort, every task, automatically.
  const ledger = routeLedger(events);

  let recipeFile: string | null = null;
  if (!opts.dryRun) {
    writeEventFile(rawClaimFile, scoped);
    recipeFile = saveRecipe(dataDir, draft.recipe);
    recordRoutes(dataDir, observationsFrom(ledger, recipeName));
    advanceClaim(dataDir, { recipeName, fromSeq, toSeq: last.seq ?? fromSeq, events: events.length, discarded: false, distilledFromSeq: scopeFromSeq });
    writeReadme(cfg, dataDir);
  }

  return {
    recipeName,
    recipeFile,
    draft: true,
    selfVerification: "pending",
    claimedRange: { from: at(events[0]), to: at(last), fromSeq, toSeq: last.seq ?? fromSeq, events: events.length },
    scope: {
      mode,
      fromSeq: scopeFromSeq,
      events: scoped.length,
      excludedSegments: segments.slice(0, startIdx).map((s) => s.index),
      excludedWouldKeep: excludedWouldKeep.map((r) => `${show(r)} (seq ${r.seq})`),
    },
    segments,
    anchorSegment,
    warnings,
    anchor: { seq: anchorSeq, url: reach.anchor.url },
    finalNavigationGuess: draft.recipe.finalNavigation,
    finalNavigationEntry,
    shape,
    existingDataRefs,
    targetHint: draft.recipe.targetHint!,
    path: trail,
    evidence: {
      kept: draft.recipe.steps.map((s, i) => ({ stepId: s.id, requestId: kept[i]?.requestId ?? "", method: s.kind === "api" ? s.call.method : "UI", url: s.kind === "api" ? s.call.url : "", reason: reasons[kept[i]?.requestId ?? ""] ?? [] })),
      dropped: {
        readOnly: requests.filter(isReadOnly).length,
        unreachable: reach.droppedUnreachable.filter((r) => !keptMap.has(r.requestId) && !isLogin(r)).map(show),
        failed: reach.droppedFailed.map(show),
        afterAnchor: reach.droppedAfterAnchor.map(show),
        authRefresh: authRefresh.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map(show),
      },
      authRequest: authEvent ? { requestId: authEvent.requestId, method: authEvent.method, url: show(authEvent) } : undefined,
      schemaProviders: providers.map((pv) => ({ kind: pv.kind, size: pv.size })),
    },
    pendingDecisions: draft.recipe.pendingDecisions ?? [],
    // A recipe with no API steps has nothing to probe, whatever the schema evidence said.
    probeRecommended: shape === "data" && draft.probeRecommended,
    stats: { ...draft.stats, shape },
    routesLearned: ledger.map((r) => r.route),
  };
}
