import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { CommandDef } from "../run.js";
import { CliError } from "../../errors.js";
import { loadConfig } from "../../config.js";
import { projectDirOf, resolveDataDir } from "../../paths.js";
import { findRoutes, getRoute, listRoutes, loadRouteCatalogue, recordRoutes, type RouteObservation } from "../../store/routeCatalogue.js";
import { extractRoutes, readJsonTree, summarise } from "../../routes/importTree.js";
import { recentRoutes } from "../../routes/recent.js";
import { tidyRaw } from "../tidyRaw.js";
import { noEventsHint, portsReport, type PortsReport } from "../portsReport.js";
import { normRoute } from "../../util/route.js";

function splitChain(raw: string): string[] {
  return raw.split(/\s*>\s*/).map((s) => s.trim()).filter((s) => s.length > 0);
}

export const routesCommand: CommandDef = {
  name: "routes",
  usage: 'routes recent [--from-seq <n>] | find <keyword> | list [--tab <name>] | get <route> | set <route> [--name <text>] [--chain "A > B"] [--evidence <text>] | import <file> [--path-field <f>] [--name-field <f>] [--children-field <f>] [--dry-run]',
  description: "Read/extend the route catalogue: which screen a path is, where it hangs in the menu, and which routes the recording just visited.",
  handler: (ctx) => {
    const dataDir = resolveDataDir(ctx.project);
    const [sub, arg] = ctx.positionals;
    switch (sub) {
      case "recent": {
        const cfg = loadConfig(dataDir);
        const tidy = tidyRaw(dataDir);
        const raw = ctx.str("from-seq");
        const result = recentRoutes(dataDir, cfg, raw !== undefined ? Number(raw) : undefined);
        const ports = result.routes.length ? undefined : portsReport(dataDir);
        return {
          ...result,
          ...tidy,
          ports,
          note: result.routes.length
            ? "These are the routes the recording actually visited, most recent first. The screen the user described is almost always here — they were looking at it while describing it."
            : `No navigations recorded since the last claim. ${noEventsHint(ports as PortsReport)}`,
        };
      }
      case "find": {
        if (!arg) throw new CliError("E_USAGE", "routes find <keyword>");
        const f = loadRouteCatalogue(dataDir);
        const hits = findRoutes(f, arg);
        return {
          query: arg,
          total: Object.keys(f.entries).length,
          filtered: hits.length,
          hits,
          note: hits.length > 1 ? "More than one screen matches — tell them apart by their menu chain, not by name alone." : undefined,
        };
      }
      case "list": {
        const f = loadRouteCatalogue(dataDir);
        const tab = ctx.str("tab");
        const hits = listRoutes(f, tab);
        return { query: { tab }, total: Object.keys(f.entries).length, filtered: hits.length, hits };
      }
      case "get": {
        if (!arg) throw new CliError("E_USAGE", "routes get <route>");
        const entry = getRoute(loadRouteCatalogue(dataDir), arg);
        return { route: normRoute(arg), found: !!entry, entry: entry ?? null };
      }
      case "set": {
        if (!arg) throw new CliError("E_USAGE", 'routes set <route> [--name <text>] [--chain "A > B"] [--evidence <text>]');
        const name = ctx.str("name");
        const chain = ctx.str("chain");
        if (!name && !chain) throw new CliError("E_USAGE", "routes set needs at least --name or --chain");
        const obs: RouteObservation = {
          source: "agent",
          names: name ? [name] : undefined,
          chains: chain ? [splitChain(chain)] : undefined,
          evidence: ctx.str("evidence"),
        };
        const f = recordRoutes(dataDir, [{ route: arg, obs }]);
        return { route: normRoute(arg), saved: true, entry: getRoute(f, arg) };
      }
      case "import": {
        if (!arg) throw new CliError("E_USAGE", "routes import <file> [--path-field <f>] [--name-field <f>] [--children-field <f>] [--dry-run]");
        const abs = resolve(arg);
        if (!existsSync(abs)) throw new CliError("E_USAGE", `File not found: ${abs}`);
        const routes = extractRoutes(readJsonTree(abs), {
          pathField: ctx.str("path-field"),
          nameField: ctx.str("name-field"),
          childrenField: ctx.str("children-field"),
        });
        const rel = relative(projectDirOf(dataDir), abs).replace(/\\/g, "/");
        const summary = summarise(routes);
        if (!routes.length) {
          return { file: rel, ...summary, applied: false, note: "No node carried the path field. Check --path-field / --children-field against the file's actual shape." };
        }
        const dryRun = ctx.bool("dry-run");
        if (!dryRun) {
          const now = new Date().toISOString();
          recordRoutes(
            dataDir,
            routes.map((r) => ({
              route: r.path,
              obs: { source: "import" as const, names: r.name ? [r.name] : undefined, chains: [r.chain], evidence: `imported from ${rel} at ${now}` },
            })),
          );
        }
        return {
          file: rel,
          ...summary,
          applied: !dryRun,
          sample: routes.slice(0, 20),
          note: "One-off seeding. The source file is not remembered and is never re-read — later corrections belong in `routes set`.",
        };
      }
      default:
        throw new CliError("E_USAGE", "routes recent | find | list | get | set | import");
    }
  },
};
