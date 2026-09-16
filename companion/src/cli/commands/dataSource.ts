import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { CommandDef } from "../run.js";
import { CliError } from "../../errors.js";
import { loadConfig } from "../../config.js";
import { projectDirOf, resolveDataDir } from "../../paths.js";
import { effectiveEntry, loadDataSourceMap, scanSource, setDataSource } from "../../store/dataSourceMap.js";
import { normRoute } from "../../util/route.js";
import { readText } from "../../util/fs.js";

export const dataSourceCommand: CommandDef = {
  name: "data-source",
  usage: "data-source list | get <route> | set <route> --verdict api|ui [--evidence <text>] [--file <path>] | scan <route> --file <component> [--apply]",
  description: "Read/update the per-route data-source map (deep-link safe vs. must enter via UI).",
  handler: (ctx) => {
    const dataDir = resolveDataDir(ctx.project);
    const [sub, route] = ctx.positionals;
    switch (sub) {
      case "list": {
        const cfg = loadConfig(dataDir);
        const map = loadDataSourceMap(dataDir);
        return {
          siteDefault: { ...cfg.navigation, note: "Every route not listed in `entries` is entered this way. The entries are exceptions to it, or routes verified individually." },
          entries: Object.fromEntries(Object.entries(map.entries).map(([r, e]) => [r, { ...e, effective: effectiveEntry(cfg, map, r) }])),
        };
      }
      case "get": {
        if (!route) throw new CliError("E_USAGE", "data-source get <route>");
        const cfg = loadConfig(dataDir);
        const map = loadDataSourceMap(dataDir);
        const entry = map.entries[normRoute(route)];
        // Not found is still an answer: the route inherits the site default.
        return { route, found: !!entry, entry: entry ?? null, effective: effectiveEntry(cfg, map, route) };
      }
      case "set": {
        const verdict = ctx.str("verdict");
        if (!route || (verdict !== "api" && verdict !== "ui")) throw new CliError("E_USAGE", "data-source set <route> --verdict api|ui [--evidence <text>] [--file <path>]");
        const file = ctx.str("file");
        const projectDir = projectDirOf(dataDir);
        const cfg = loadConfig(dataDir);
        const map = setDataSource(dataDir, route, { verdict, evidence: ctx.str("evidence") ?? "", source: "manual", file: file ? relative(projectDir, resolve(file)).replace(/\\/g, "/") : undefined }, cfg.navigation);
        return { route, verdict, saved: true, effective: effectiveEntry(cfg, map, route), siteDefault: cfg.navigation };
      }
      case "scan": {
        const file = ctx.str("file");
        if (!route || !file) throw new CliError("E_USAGE", "data-source scan <route> --file <component> [--apply]");
        const abs = resolve(file);
        if (!existsSync(abs)) throw new CliError("E_USAGE", `File not found: ${abs}`);
        const cfg = loadConfig(dataDir);
        const suggestions = scanSource(cfg, readText(abs));
        // ui wins when any rule says the screen needs real UI; otherwise api if any rule says so.
        const verdict = suggestions.some((s) => s.verdict === "ui") ? "ui" : suggestions.some((s) => s.verdict === "api") ? "api" : null;
        const projectDir = projectDirOf(dataDir);
        const rel = relative(projectDir, abs).replace(/\\/g, "/");
        const applied = !!(verdict && ctx.bool("apply"));
        if (verdict && applied) {
          setDataSource(dataDir, route, { verdict, evidence: suggestions.map((s) => s.evidence).join("; "), source: "scan", file: rel }, cfg.navigation);
        }
        return {
          route, file: rel, verdict, applied, suggestions,
          effective: applied ? effectiveEntry(cfg, loadDataSourceMap(dataDir), route) : undefined,
          siteDefault: cfg.navigation,
          note: verdict ? undefined : "No rule matched — decide manually and run data-source set.",
        };
      }
      default:
        throw new CliError("E_USAGE", "data-source list | get | set | scan");
    }
  },
};
