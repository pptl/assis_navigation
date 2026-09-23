import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { CommandDef, CommandContext } from "../run.js";
import type { Recipe } from "../../recipe.js";
import { CliError } from "../../errors.js";
import { DATA_DIR_NAME, examplesDir, resolveDataDir } from "../../paths.js";
import { loadConfig } from "../../config.js";
import { saveRecipe } from "../../store/recipes.js";
import { readJson } from "../../util/fs.js";
import { CATALOGUE, type AnswerSource } from "../../onboarding/catalogue.js";
import {
  answersFromTemplate, loadOnboarding, requireComplete, saveOnboarding, setAnswer, smokeAnswers, startOnboarding, statusReport, toActors, toConfig,
  type OnboardingState,
} from "../../onboarding/state.js";
import { buildSmokeRecipe, SMOKE_RECIPE_NAME } from "../../onboarding/smokeRecipe.js";
import { collectEndpointStats } from "../../onboarding/endpointStats.js";
import { exportTemplate } from "../../onboarding/exportTemplate.js";
import { finishScaffold, readActorsFile, scaffoldDataDir, writeActorsFile, writeConfigFile } from "../../onboarding/scaffold.js";

const SOURCES: AnswerSource[] = ["code", "user", "verified", "default", "template"];

function listTemplates(): string[] {
  try {
    return readdirSync(examplesDir()).filter((d) => existsSync(join(examplesDir(), d, "config.json")));
  } catch {
    return [];
  }
}

/** During onboarding config.json does not exist yet, so resolve via onboarding.json as well. */
function resolveOnboardingDir(ctx: CommandContext): { dataDir: string; projectDir: string } {
  const explicit = ctx.project;
  if (explicit) {
    const projectDir = resolve(explicit);
    return { dataDir: join(projectDir, DATA_DIR_NAME), projectDir };
  }
  try {
    const dataDir = resolveDataDir(undefined, { allowOnboarding: true });
    return { dataDir, projectDir: resolve(dataDir, "..") };
  } catch {
    const projectDir = process.cwd();
    return { dataDir: join(projectDir, DATA_DIR_NAME), projectDir };
  }
}

function loadOrFail(dataDir: string): OnboardingState {
  const state = loadOnboarding(dataDir);
  if (!state) throw new CliError("E_NO_ONBOARDING", `No onboarding in progress at ${dataDir}. Run "nav-recorder init" first.`);
  return state;
}

function parseValue(raw: string | undefined, fromFile: string | undefined): unknown {
  if (fromFile) return readJson<unknown>(resolve(fromFile));
  if (raw === undefined) throw new CliError("E_USAGE", "init answer <field> --value <json|string> [--source ...] [--evidence ...]");
  try { return JSON.parse(raw); } catch { return raw; }
}

// ---------- subcommands ----------

function start(ctx: CommandContext): unknown {
  const { dataDir, projectDir } = resolveOnboardingDir(ctx);
  const configFile = join(dataDir, "config.json");
  const force = ctx.bool("force");
  if (existsSync(configFile) && !force) {
    throw new CliError("E_EXISTS", `${configFile} already exists. Use --force to re-onboard (config.json will be replaced on finalize; actors.json passwords and recorded data are kept).`);
  }
  const existing = loadOnboarding(dataDir);
  if (existing && existing.status === "collecting" && !force) {
    return { resumed: true, dataDir, ...statusReport(existing), next: "Continue answering with `nav-recorder init answer <field> ...`, then `nav-recorder init finalize`." };
  }
  scaffoldDataDir(dataDir);
  const state = startOnboarding(projectDir, ctx.str("name"));

  const template = ctx.str("template");
  if (template && template !== "blank") {
    const dir = join(examplesDir(), template);
    if (!existsSync(join(dir, "config.json"))) throw new CliError("E_NO_TEMPLATE", `Template "${template}" not found. Available: ${listTemplates().join(", ") || "(none)"}, blank`);
    const { copiedRecipes } = answersFromTemplate(state, dir);
    saveOnboarding(dataDir, state);
    return finalize(ctx, { state, dataDir, projectDir, noExport: true, templateRecipes: copiedRecipes });
  }
  if (template === "blank") {
    // Nothing to prefill beyond the mechanical defaults; still goes through the questionnaire.
  }
  saveOnboarding(dataDir, state);
  const report = statusReport(state);
  return {
    started: true,
    dataDir,
    onboardingFile: join(dataDir, "onboarding.json"),
    ...report,
    next: [
      "For each missingRequired field: look where `hint` says, verify with Playwright where `verify` says, then `nav-recorder init answer <field> --value <json> --source code|verified --evidence \"<where you found it>\"`.",
      "Ask the user the `question` of every field you cannot infer (batch them in one round), then answer with --source user.",
      "Run `nav-recorder init status` any time; `nav-recorder init finalize` when complete.",
    ],
  };
}

function status(ctx: CommandContext): unknown {
  const { dataDir } = resolveOnboardingDir(ctx);
  const state = loadOrFail(dataDir);
  return { dataDir, ...statusReport(state) };
}

function answer(ctx: CommandContext): unknown {
  const { dataDir } = resolveOnboardingDir(ctx);
  const state = loadOrFail(dataDir);
  if (state.status === "finalized" && !ctx.bool("force")) throw new CliError("E_FINALIZED", "Onboarding already finalized. Use --force to change an answer (then re-run `init finalize --force`).");
  const source = (ctx.str("source") ?? "code") as AnswerSource;
  if (!SOURCES.includes(source)) throw new CliError("E_USAGE", `--source must be one of ${SOURCES.join("|")}`);
  const evidence = ctx.str("evidence");
  const applied: string[] = [];

  const bulk = ctx.str("from-file");
  const field = ctx.positionals[1];
  if (bulk && !field) {
    const answers = readJson<Record<string, unknown>>(resolve(bulk));
    for (const [key, v] of Object.entries(answers)) {
      const entry = (v && typeof v === "object" && "value" in (v as object)) ? (v as { value: unknown; source?: AnswerSource; evidence?: string }) : { value: v };
      setAnswer(state, key, entry.value, entry.source ?? source, entry.evidence ?? evidence);
      applied.push(key);
    }
  } else {
    if (!field) throw new CliError("E_USAGE", "init answer <field> --value <json|string> | init answer --from-file <answers.json>");
    setAnswer(state, field, parseValue(ctx.str("value"), ctx.str("value-file")), source, evidence);
    applied.push(field);
  }
  saveOnboarding(dataDir, state);
  const report = statusReport(state);
  const api = state.fields.apiBases;
  return {
    applied,
    complete: report.complete,
    missingRequired: report.missingRequired.map((m) => m.key),
    unconfirmed: report.unconfirmed.map((u) => u.key),
    resolvedPreview: applied.includes("apiBases") && api ? { apiBases: api.resolved, traces: api.traces } : undefined,
    warnings: report.warnings,
  };
}

function suggestReadonly(ctx: CommandContext): unknown {
  const { dataDir, projectDir } = resolveOnboardingDir(ctx);
  const glob = ctx.str("files");
  if (!glob) throw new CliError("E_USAGE", 'init suggest-readonly --files "<glob of service/adapter files>" [--min 2]');
  const min = ctx.str("min") !== undefined ? Number(ctx.str("min")) : 2;
  if (!Number.isFinite(min) || min < 1) throw new CliError("E_USAGE", "--min must be a positive integer");
  const stats = collectEndpointStats(projectDir, glob, min);
  if (stats.files === 0) throw new CliError("E_USAGE", `No files matched ${glob} under ${projectDir}`);
  const state = loadOnboarding(dataDir);
  if (state) {
    state.meta = { ...(state.meta ?? {}), endpointStats: stats };
    saveOnboarding(dataDir, state);
  }
  return {
    ...stats,
    next: [
      "Classify EVERY verb with count >= min: read → include in the pattern; write → leave out; unclassified → open one example endpoint's call site and decide.",
      `Then: nav-recorder init answer readOnlyPatterns --value '["${stats.proposedPattern ?? "(Read|Verbs)$"}"]' --source code --evidence "<glob>: <how you classified each verb>"`,
      "suggestedReadVerbs / suggestedWriteVerbs are vocabulary hints only — a verb that reads in one project may write in another.",
    ],
  };
}

interface FinalizeOpts { state?: OnboardingState; dataDir?: string; projectDir?: string; noExport?: boolean; templateRecipes?: string[] }

function finalize(ctx: CommandContext, opts: FinalizeOpts = {}): unknown {
  const resolved = opts.dataDir && opts.projectDir ? { dataDir: opts.dataDir, projectDir: opts.projectDir } : resolveOnboardingDir(ctx);
  const { dataDir, projectDir } = resolved;
  const state = opts.state ?? loadOrFail(dataDir);
  const force = ctx.bool("force");
  if (state.status === "finalized" && !force && !opts.state) throw new CliError("E_FINALIZED", "Already finalized. Use --force to regenerate config.json / login-ready from the current answers.");
  requireComplete(state);

  const cfg = toConfig(state);
  const configFile = join(dataDir, "config.json");
  if (existsSync(configFile) && !force && !opts.state) throw new CliError("E_EXISTS", `${configFile} exists. Use --force to overwrite.`);
  scaffoldDataDir(dataDir);
  const created: string[] = [writeConfigFile(dataDir, cfg)];

  const actors = toActors(state, readActorsFile(dataDir));
  created.push(writeActorsFile(dataDir, actors));

  const recipes: string[] = [];
  if (opts.templateRecipes?.length) {
    for (const f of opts.templateRecipes) {
      const r = readJson<Recipe & { $schema?: string }>(f);
      delete r.$schema;
      recipes.push(saveRecipe(dataDir, r));
    }
  }
  const smoke = smokeAnswers(state);
  if (smoke && !recipes.some((f) => basename(f) === `${SMOKE_RECIPE_NAME}.json`)) {
    recipes.push(saveRecipe(dataDir, buildSmokeRecipe(state)));
  }

  const { created: more, origins, gitignore } = finishScaffold(dataDir, projectDir, cfg);
  created.push(...more);
  const quoted = (ps: string[]): string => ps.map((p) => `"${p}"`).join(", ");
  const whyIgnore = ".nav-recorder/ holds credentials and raw traffic; .playwright-mcp/ is where the Playwright MCP server dumps page snapshots, console logs and screenshots — neither must ever be committed.";
  const gitignoreNext =
    gitignore.status === "no-git-root"
      ? `No git repository found above ${projectDir}: add ${quoted(gitignore.patterns)} to the project's .gitignore yourself (or wherever it will be versioned). ${whyIgnore}`
      : gitignore.status === "added"
        ? `Added ${quoted(gitignore.added)} to ${gitignore.file}${gitignore.aboveProject ? " (the git root is above the project directory)" : ""}${gitignore.present.length ? `; ${quoted(gitignore.present)} already there` : ""}. Tell the user this tracked file changed so it goes into their next commit. ${whyIgnore}`
        : `${quoted(gitignore.patterns)} were already in ${gitignore.file}.`;

  state.status = "finalized";
  state.finalizedAt = new Date().toISOString();
  saveOnboarding(dataDir, state);

  let exported: { templateDir: string; files: string[] } | null = null;
  const noExport = opts.noExport || ctx.bool("no-export");
  if (!noExport) {
    const name = ctx.str("export-name") ?? cfg.name;
    exported = exportTemplate(dataDir, cfg, actors, name, { force });
  }

  const report = statusReport(state);
  const placeholders = Object.entries(actors.actors).filter(([, a]) => a.password === "CHANGE_ME").map(([role]) => role);
  return {
    finalized: true,
    dataDir,
    config: configFile,
    created,
    recipes,
    exported,
    registeredOrigins: origins,
    gitignore,
    unconfirmed: report.unconfirmed,
    warnings: report.warnings,
    resolvedApiBases: cfg.apiBases,
    passwordsToFill: placeholders,
    next: [
      gitignoreNext,
      ...(report.warnings.length ? [`There are ${report.warnings.length} warning(s) above — resolve each one (re-answer with --force) or explain to the user why it is acceptable.`] : []),
      placeholders.length ? `Ask the user to fill passwords for ${placeholders.join(", ")} in ${join(dataDir, "actors.json")} (never paste passwords into chat).` : "All actor passwords are set.",
      "Run `nav-recorder doctor` — the extension must be loaded. Nothing registers a port: every loopback page is recorded and the companion works out which project the port belongs to, so the dev server can move ports freely (`nav-recorder ports` shows where recordings are going).",
      `Prove the config with \`nav-recorder execute-start ${SMOKE_RECIPE_NAME}\` and the execute loop from the Skill.`,
      report.unconfirmed.length ? `Tell the user which answers were inferred, not confirmed: ${report.unconfirmed.map((u) => u.key).join(", ")}.` : "All answers were confirmed by the user or verified live.",
    ],
  };
}

function exportCmd(ctx: CommandContext): unknown {
  const dataDir = resolveDataDir(ctx.project);
  const cfg = loadConfig(dataDir);
  const actors = readActorsFile(dataDir) ?? { actors: {} };
  return exportTemplate(dataDir, cfg, actors, ctx.str("name") ?? cfg.name, { force: ctx.bool("force") });
}

function catalogue(): unknown {
  return {
    fields: CATALOGUE.map((f) => ({ key: f.key, required: f.required, configPath: f.configPath, default: f.default, hint: f.hint, verify: f.verify, question: f.question })),
  };
}

export const initCommand: CommandDef = {
  name: "init",
  usage: "init [--project <dir>] [--name <n>] [--template <examples/<name>>] [--force] | init status | init answer <field> --value <json> [--source code|user|verified|default] [--evidence <text>] | init answer --from-file <json> | init suggest-readonly --files <glob> [--min 2] | init finalize [--force] [--no-export] [--export-name <n>] | init export-template [--name <n>] [--force] | init catalogue",
  description: "Onboard a project: start the questionnaire, answer fields with evidence, finalize into config.json + actors.json + login-ready recipe (+ examples/<name>/ template).",
  handler: (ctx) => {
    const sub = ctx.positionals[0];
    switch (sub) {
      case undefined: return start(ctx);
      case "status": return status(ctx);
      case "answer": return answer(ctx);
      case "finalize": return finalize(ctx);
      case "suggest-readonly": return suggestReadonly(ctx);
      case "export-template": return exportCmd(ctx);
      case "catalogue": return catalogue();
      default: throw new CliError("E_USAGE", `Unknown init subcommand: ${sub}. Use: (none) | status | answer | suggest-readonly | finalize | export-template | catalogue`);
    }
  },
};
