import { p } from "../paths.js";
import { readJson, writeJsonAtomic, writeText } from "../util/fs.js";
import { normRoute } from "../util/route.js";

/**
 * The route catalogue: "which screen does the user mean, and where does it hang in the menu".
 *
 * It is an *accumulating* table, like data-source-map: nothing here is derived from a project file
 * at query time. Entries arrive three ways — `observed` (mechanically, from what the recording
 * actually visited), `agent` (Agent dev writing down what it worked out) and `import` (a one-off
 * seeding from whatever route table / menu config / webmap a project happens to have). A project
 * with none of those still ends up with a useful table after a few tasks.
 */

export type RouteSource = "observed" | "import" | "agent";

/** How much a source is trusted when two of them describe the same route. */
const CONFIDENCE: Record<RouteSource, number> = { observed: 0, import: 1, agent: 2 };

export interface RoutePlacement {
  /** menu ancestors, outermost first — e.g. ["Sales", "sidebar", "訂單管理"] */
  chain: string[];
  source: RouteSource;
}

export interface RouteEntry {
  /** human names for the screen: the menu label, the words the user used, ... */
  names: string[];
  placements: RoutePlacement[];
  /** how many times a recording was seen to visit this route */
  seenInRecordings: number;
  /** click labels recorded on the way into this route */
  enteredBy: string[];
  source: RouteSource;
  evidence: string;
  firstSeenAt: string;
  updatedAt: string;
}

export interface RouteCatalogueFile {
  entries: Record<string, RouteEntry>;
}

/** One thing learned about one route. Every field is optional except the source. */
export interface RouteObservation {
  names?: string[];
  chains?: string[][];
  /** added to seenInRecordings */
  seen?: number;
  enteredBy?: string[];
  source: RouteSource;
  evidence?: string;
}

const MAX_ENTERED_BY = 5;

export function catalogueJsonPath(dataDir: string): string {
  return p(dataDir, "route-catalogue.json");
}

export function catalogueMdPath(dataDir: string): string {
  return p(dataDir, "route-catalogue.md");
}

export function loadRouteCatalogue(dataDir: string): RouteCatalogueFile {
  const f = readJson<Partial<RouteCatalogueFile>>(catalogueJsonPath(dataDir), {});
  return { entries: f.entries ?? {} };
}

/**
 * The stored key for a route, preserving the casing it was first written with.
 * `normRoute` deliberately does not lower-case (data-source-map keys are stored in the app's own
 * casing), so lookups have to be case-insensitive by hand.
 */
export function findKey(f: RouteCatalogueFile, route: string): string | undefined {
  const want = normRoute(route).toLowerCase();
  return Object.keys(f.entries).find((k) => k.toLowerCase() === want);
}

export function getRoute(f: RouteCatalogueFile, route: string): RouteEntry | undefined {
  const key = findKey(f, route);
  return key ? f.entries[key] : undefined;
}

function chainKey(chain: string[]): string {
  return chain.map((s) => s.trim()).join(" > ").toLowerCase();
}

/** Merge one observation into an entry. Never overwrites: names, placements and counts accumulate. */
export function mergeEntry(prev: RouteEntry | undefined, obs: RouteObservation, now: string): RouteEntry {
  const names = [...(prev?.names ?? [])];
  for (const n of obs.names ?? []) {
    const t = n.trim();
    if (t && !names.some((x) => x.toLowerCase() === t.toLowerCase())) names.push(t);
  }

  const placements = (prev?.placements ?? []).map((pl) => ({ ...pl, chain: [...pl.chain] }));
  for (const raw of obs.chains ?? []) {
    const chain = raw.map((s) => s.trim()).filter((s) => s.length > 0);
    if (!chain.length) continue;
    const existing = placements.find((pl) => chainKey(pl.chain) === chainKey(chain));
    if (existing) {
      // same placement seen again from a more trustworthy source → upgrade the attribution
      if (CONFIDENCE[obs.source] > CONFIDENCE[existing.source]) existing.source = obs.source;
    } else {
      placements.push({ chain, source: obs.source });
    }
  }

  const enteredBy = [...(prev?.enteredBy ?? [])];
  for (const e of obs.enteredBy ?? []) {
    const t = e.replace(/\s+/g, " ").trim();
    if (t && !enteredBy.includes(t) && enteredBy.length < MAX_ENTERED_BY) enteredBy.push(t);
  }

  const source = prev && CONFIDENCE[prev.source] > CONFIDENCE[obs.source] ? prev.source : obs.source;

  return {
    names,
    placements,
    seenInRecordings: (prev?.seenInRecordings ?? 0) + (obs.seen ?? 0),
    enteredBy,
    source,
    evidence: obs.evidence?.trim() ? `[${obs.source}] ${obs.evidence.trim()}` : prev?.evidence ?? "",
    firstSeenAt: prev?.firstSeenAt ?? now,
    updatedAt: now,
  };
}

/**
 * Merge a batch of observations and write both files once.
 * Batched on purpose: one capture-recent contributes every route the recording visited.
 */
export function recordRoutes(dataDir: string, records: { route: string; obs: RouteObservation }[]): RouteCatalogueFile {
  const f = loadRouteCatalogue(dataDir);
  const now = new Date().toISOString();
  for (const { route, obs } of records) {
    const key = findKey(f, route) ?? normRoute(route);
    f.entries[key] = mergeEntry(f.entries[key], obs, now);
  }
  writeJsonAtomic(catalogueJsonPath(dataDir), f);
  writeText(catalogueMdPath(dataDir), renderRouteCatalogue(f));
  return f;
}

export interface RouteHit {
  route: string;
  entry: RouteEntry;
  /** which field the query matched */
  matched: ("route" | "name" | "chain")[];
}

/** Case-insensitive substring search over route, names and menu chains. Mechanical only. */
export function findRoutes(f: RouteCatalogueFile, query: string): RouteHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: RouteHit[] = [];
  for (const [route, entry] of Object.entries(f.entries)) {
    const matched: RouteHit["matched"] = [];
    if (route.toLowerCase().includes(q)) matched.push("route");
    if (entry.names.some((n) => n.toLowerCase().includes(q))) matched.push("name");
    if (entry.placements.some((pl) => pl.chain.some((c) => c.toLowerCase().includes(q)))) matched.push("chain");
    if (matched.length) out.push({ route, entry, matched });
  }
  // a name match is the strongest signal that this is the screen the user described
  const rank = (h: RouteHit) => (h.matched.includes("name") ? 0 : h.matched.includes("route") ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.entry.seenInRecordings - a.entry.seenInRecordings || a.route.localeCompare(b.route));
}

/** All routes, optionally only those hanging under a given outermost menu entry. */
export function listRoutes(f: RouteCatalogueFile, tab?: string): RouteHit[] {
  const want = tab?.trim().toLowerCase();
  const out: RouteHit[] = [];
  for (const [route, entry] of Object.entries(f.entries)) {
    if (want && !entry.placements.some((pl) => (pl.chain[0] ?? "").toLowerCase() === want)) continue;
    out.push({ route, entry, matched: [] });
  }
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

/** Outermost menu entry a route hangs under, or "" when nothing is known about its placement. */
function tabOf(entry: RouteEntry): string {
  return entry.placements[0]?.chain[0] ?? "";
}

const UNPLACED = "(未歸類)";

export function renderRouteCatalogue(f: RouteCatalogueFile): string {
  const lines = [
    "# route-catalogue",
    "",
    "Which screen the user means, which path it is, and where it hangs in the menu. Accumulated over",
    "tasks — `observed` comes from what a recording actually visited, `agent` from Agent dev writing",
    "down what it worked out, `import` from a one-off seeding of a project route table.",
    "Query with `nav-recorder routes find <keyword>`; add to it with `nav-recorder routes set <route>`.",
    "",
  ];
  const byTab = new Map<string, string[]>();
  for (const key of Object.keys(f.entries).sort()) {
    const e = f.entries[key];
    const tab = tabOf(e) || UNPLACED;
    const cell = (s: string) => s.replace(/\|/g, "\\|");
    const placements = e.placements.map((pl) => pl.chain.join(" > ")).join(" / ") || "—";
    const row = `| \`${key}\` | ${cell(e.names.join(" / ")) || "—"} | ${cell(placements)} | ${e.source} | ${e.seenInRecordings} | ${cell(e.enteredBy.join(" / "))} |`;
    if (!byTab.has(tab)) byTab.set(tab, []);
    byTab.get(tab)!.push(row);
  }
  const tabs = [...byTab.keys()].sort((a, b) => (a === UNPLACED ? 1 : b === UNPLACED ? -1 : a.localeCompare(b)));
  if (!tabs.length) {
    lines.push("_(empty — it fills up as tasks run)_", "");
    return lines.join("\n");
  }
  for (const tab of tabs) {
    lines.push(`## ${tab}`, "", "| route | names | menu | source | seen | entered by |", "|---|---|---|---|---|---|", ...byTab.get(tab)!, "");
  }
  return lines.join("\n");
}
