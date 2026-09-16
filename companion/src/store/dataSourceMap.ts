import type { NavConfig, NavigationConfig, NavigationEntry } from "../types.js";
import { p } from "../paths.js";
import { readJson, writeJsonAtomic, writeText } from "../util/fs.js";
import { normRoute } from "../util/route.js";

export interface DataSourceEntry {
  /** api = safe to deep-link (data re-fetched on mount); ui = must be entered through real UI */
  verdict: "api" | "ui";
  evidence: string;
  source: "manual" | "scan";
  file?: string;
  updatedAt: string;
}

export interface DataSourceMapFile {
  entries: Record<string, DataSourceEntry>;
}

/** How a route should be entered, and whether that came from the route itself or the site default. */
export interface EffectiveEntry {
  entry: NavigationEntry;
  from: "route" | "site-default";
  /** present only when `from` is "route" */
  verdict?: "api" | "ui";
  evidence?: string;
}

/** The single place the per-route verdict vocabulary maps onto the navigation vocabulary. */
export function entryOfVerdict(verdict: "api" | "ui"): NavigationEntry {
  return verdict === "api" ? "deeplink" : "menu";
}

/**
 * The answer the Agent actually needs: this route's own verdict when the map has one, otherwise the
 * site-wide default. A route missing from the map is not "no knowledge" — it inherits.
 */
export function effectiveEntry(cfg: NavConfig, map: DataSourceMapFile, route: string): EffectiveEntry {
  const own = map.entries[normRoute(route)];
  if (own) return { entry: entryOfVerdict(own.verdict), from: "route", verdict: own.verdict, evidence: own.evidence };
  return { entry: cfg.navigation.entry, from: "site-default", evidence: cfg.navigation.evidence };
}

export function loadDataSourceMap(dataDir: string): DataSourceMapFile {
  const f = readJson<Partial<DataSourceMapFile>>(p(dataDir, "data-source-map.json"), {});
  return { entries: f.entries ?? {} };
}

export function getDataSource(dataDir: string, route: string): DataSourceEntry | undefined {
  return loadDataSourceMap(dataDir).entries[normRoute(route)];
}

export function setDataSource(dataDir: string, route: string, entry: Omit<DataSourceEntry, "updatedAt">, site?: NavigationConfig): DataSourceMapFile {
  const f = loadDataSourceMap(dataDir);
  f.entries[normRoute(route)] = { ...entry, updatedAt: new Date().toISOString() };
  writeJsonAtomic(p(dataDir, "data-source-map.json"), f);
  writeText(p(dataDir, "data-source-map.md"), renderDataSourceMap(f, site));
  return f;
}

export interface ScanSuggestion {
  verdict: "api" | "ui";
  rule: string;
  evidence: string;
}

/** Apply config.dataSourceRules to a component's source text. Mechanical only; Agent dev decides. */
export function scanSource(cfg: NavConfig, text: string): ScanSuggestion[] {
  const out: ScanSuggestion[] = [];
  for (const rule of cfg.dataSourceRules) {
    let re: RegExp;
    try { re = new RegExp(rule.pattern); } catch { continue; }
    const m = re.exec(text);
    if (!m) continue;
    const line = text.slice(0, m.index).split("\n").length;
    if (rule.requiresAlso) {
      const also = new RegExp(rule.requiresAlso).test(text);
      if (!also && rule.verdictIfMissing) out.push({ verdict: rule.verdictIfMissing, rule: rule.pattern, evidence: `matched /${rule.pattern}/ at line ${line} but not /${rule.requiresAlso}/${rule.note ? ` — ${rule.note}` : ""}` });
      else if (also && rule.verdict) out.push({ verdict: rule.verdict, rule: rule.pattern, evidence: `matched /${rule.pattern}/ and /${rule.requiresAlso}/${rule.note ? ` — ${rule.note}` : ""}` });
      else if (also) out.push({ verdict: "api", rule: rule.pattern, evidence: `matched /${rule.pattern}/ together with /${rule.requiresAlso}/${rule.note ? ` — ${rule.note}` : ""}` });
    } else if (rule.verdict) {
      out.push({ verdict: rule.verdict, rule: rule.pattern, evidence: `matched /${rule.pattern}/ at line ${line}${rule.note ? ` — ${rule.note}` : ""}` });
    }
  }
  return out;
}

const SITE_DEFAULT_LABEL: Record<NavigationEntry, string> = {
  deeplink: "`deeplink` — navigating straight to a URL renders the screen",
  menu: "`menu` — screens must be entered through the app's own navigation",
  unknown: "`unknown` — never established; observe once and write it back",
};

export function renderDataSourceMap(f: DataSourceMapFile, site?: NavigationConfig): string {
  const entry = site?.entry ?? "unknown";
  const lines = [
    "# data-source-map",
    "",
    "Whether a route can be reached by deep link after API-side setup (`api`) or must be entered through",
    "real UI so the app runs its own loading logic (`ui`). Filled by Agent dev while locating components;",
    "query with `nav-recorder data-source get <route>`.",
    "",
    `**Site default (config.navigation.entry): ${SITE_DEFAULT_LABEL[entry]}.**`,
    ...(site?.evidence ? [`Evidence: ${site.evidence}`] : []),
    "",
    "Every route *not* listed below inherits that default. The rows are therefore exceptions to it, or",
    "routes whose behaviour was verified individually — both are worth recording: on a `menu` site each",
    "verified `api` row is a deep-link shortcut, on a `deeplink` site each `ui` row is a trap avoided.",
    "",
    "| route | verdict | source | evidence |",
    "|---|---|---|---|",
  ];
  const keys = Object.keys(f.entries).sort();
  for (const k of keys) {
    const e = f.entries[k];
    lines.push(`| \`${k}\` | ${e.verdict} | ${e.source}${e.file ? ` (\`${e.file}\`)` : ""} | ${e.evidence.replace(/\|/g, "\\|")} |`);
  }
  if (!keys.length) lines.push("| _(empty)_ | | | |");
  lines.push("");
  return lines.join("\n");
}
