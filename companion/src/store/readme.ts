import type { NavConfig } from "../types.js";
import { p } from "../paths.js";
import { listRecipes } from "./recipes.js";
import { writeText } from "../util/fs.js";

/** Local entry point for Agent dev: what exists on this machine and how to read it. */
export function renderReadme(cfg: NavConfig, dataDir: string): string {
  const recipes = listRecipes(dataDir);
  const recipeLines = recipes.length
    ? recipes.map((r) => `- **${r.name}** [${r.shape}] — ${r.description ?? "(no description)"}\n  - target: \`${r.targetUrl ?? "?"}\` → finalNavigation: \`${r.finalNavigation}\` (${r.steps} steps, ${r.createdAt || "?"})`).join("\n")
    : "_(none yet — run `nav-recorder capture-recent \"<desc>\" --target-url <path>` at the start of a task)_";

  return `# .nav-recorder — ${cfg.name}

This directory is local-only (git-ignored). It is read and written by the \`nav-recorder\` Companion.
Agent dev: follow the \`nav-recorder\` Skill; this file only tells you what exists here.

## Preconditions (recipes)

${recipeLines}

The tag after each name is its **shape**: \`navigation\` = a route through the app, nothing created (only the last hop can break); \`navigation-existing-data\` = the same, but the target screen shows a record no step creates, so it must already be in the test database; \`data\` = has API steps that build state.

Query with \`nav-recorder list\` / \`nav-recorder get-recipe <name>\`; run with \`nav-recorder execute-start <name>\`.

## Lookup tables

- \`route-catalogue.md\` — which screen a route is (names) and where it hangs in the menu, grouped by the outermost menu entry. Fills up on its own: every claimed recording adds the routes it visited. Query with \`nav-recorder routes find <keyword>\` / \`routes recent\`; add what you work out with \`nav-recorder routes set <route>\`.
- \`data-source-map.md\` — how screens are entered. The **site default is \`${cfg.navigation.entry}\`** (\`config.navigation\`), and every route not listed inherits it; the rows are exceptions to that default, or routes verified one by one. \`nav-recorder data-source get <route>\` answers for any route, listed or not, in its \`effective\` field.
- \`param-constraints.md\` — per-API parameter uniqueness findings. \`source: code\` = read from schema, trustworthy; \`source: runtime-probe\` = inferred from a duplicate-probe error, re-check when something looks off.

## Raw recordings

- \`raw/YYYY-MM-DD.ndjson\` — rolling buffer of request/navigation/interaction events from the extension. Response bodies of 512+ characters are stored once in \`YYYY-MM-DD.bodies.ndjson\` and referenced by \`responseBodyRef\`; every call still has its own line. A day file goes ${cfg.recording.bufferHours}h after its day ends once every event in it has been claimed or discarded; unclaimed events are kept up to ${cfg.recording.unclaimedKeepDays} days. Daily files are only storage: the unit of a recording is the **claim** (everything since the last \`capture-recent\`). Several browsing sessions can share one claim; \`capture-recent\` distils only the one that reached the target (\`scope\`), claims the rest without distilling it, and names any step it left out (\`excludedSteps\`); \`--all\` distils the whole claim. To start over without producing a recipe run \`nav-recorder discard\` (the claim pointer moves; files then go by the rule above).
- \`raw/auth-provenance.json\` — token/cookie → producing request map (Layer 2b).
- \`raw/claims/\` — the exact event slice each recipe was distilled from, with its own \`.bodies.ndjson\` so it survives the day files (kept for post-mortem, never deleted).

## Other

- \`config.json\` — project config (origins, API bases, read-only patterns, auth, login, storage reset, schema sources, data-source rules).
- \`onboarding.json\` — where every config value came from (source: code / user / verified / default / template, with evidence). Re-run \`nav-recorder init status\` to see it.
- \`actors.json\` — test-account credentials per actor. Real credentials: keep OS file permissions tight.
- \`sessions/\` — transient state for \`execute-*\` coordination; safe to delete when no execution is in flight.

App origins: ${cfg.appOrigins.map((o) => `\`${o}\``).join(", ")}
API bases: ${cfg.apiBases.map((o) => `\`${o}\``).join(", ")}
`;
}

export function writeReadme(cfg: NavConfig, dataDir: string): string {
  const file = p(dataDir, "README.md");
  writeText(file, renderReadme(cfg, dataDir));
  return file;
}
