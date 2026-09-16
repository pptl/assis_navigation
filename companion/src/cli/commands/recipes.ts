import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandDef } from "../run.js";
import type { Recipe } from "../../recipe.js";
import type { ActorsFile } from "../../types.js";
import { CliError } from "../../errors.js";
import { loadConfig } from "../../config.js";
import { p, resolveDataDir } from "../../paths.js";
import { filterRecipes, listRecipes, loadRecipe, saveRecipe } from "../../store/recipes.js";
import { writeReadme } from "../../store/readme.js";
import { readJson } from "../../util/fs.js";

export const listCommand: CommandDef = {
  name: "list",
  usage: "list [--target-url <path>] [--match <keyword>]",
  description: "List precondition recipes for the current project; filter by target route or keyword to avoid reading them all.",
  handler: (ctx) => {
    const dataDir = resolveDataDir(ctx.project);
    const all = listRecipes(dataDir);
    const query = { targetUrl: ctx.str("target-url"), match: ctx.str("match") };
    const recipes = filterRecipes(all, query);
    return { dataDir, total: all.length, filtered: recipes.length !== all.length || !!(query.targetUrl || query.match), query, recipes };
  },
};

export const getRecipeCommand: CommandDef = {
  name: "get-recipe",
  usage: "get-recipe <name>",
  description: "Print one recipe.",
  handler: (ctx) => {
    const name = ctx.positionals[0];
    if (!name) throw new CliError("E_USAGE", "get-recipe <name>");
    const dataDir = resolveDataDir(ctx.project);
    return loadRecipe(dataDir, name);
  },
};

export const saveRecipeCommand: CommandDef = {
  name: "save-recipe",
  usage: "save-recipe <file.json> [--name <override>]",
  description: "Validate a recipe JSON file and store it under preconditions/ (used after filling a draft).",
  handler: (ctx) => {
    const file = ctx.positionals[0];
    if (!file) throw new CliError("E_USAGE", "save-recipe <file.json>");
    const abs = resolve(file);
    if (!existsSync(abs)) throw new CliError("E_USAGE", `File not found: ${abs}`);
    const dataDir = resolveDataDir(ctx.project);
    const cfg = loadConfig(dataDir);
    const recipe = readJson<Recipe>(abs);
    if (ctx.str("name")) recipe.name = ctx.str("name")!;
    if (!recipe.createdAt) recipe.createdAt = new Date().toISOString();
    const saved = saveRecipe(dataDir, recipe);
    writeReadme(cfg, dataDir);
    return { saved, name: recipe.name, steps: recipe.steps.length };
  },
};

export const getActorCommand: CommandDef = {
  name: "get-actor",
  usage: "get-actor <name>",
  description: "Print one actor's credentials from actors.json.",
  handler: (ctx) => {
    const name = ctx.positionals[0];
    if (!name) throw new CliError("E_USAGE", "get-actor <name>");
    const dataDir = resolveDataDir(ctx.project);
    const a = readJson<ActorsFile>(p(dataDir, "actors.json"), { actors: {} });
    const actor = a.actors?.[name];
    if (!actor) throw new CliError("E_NO_ACTOR", `Actor "${name}" not found. Known: ${Object.keys(a.actors ?? {}).join(", ") || "(none)"}`);
    return { name, ...actor };
  },
};
