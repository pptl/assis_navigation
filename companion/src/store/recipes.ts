import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Recipe, RecipeMatch, RecipeMatchResult, RecipeSummary } from "../recipe.js";
import { recipeShape, validateRecipe } from "../recipe.js";
import { CliError } from "../errors.js";
import { p } from "../paths.js";
import { ensureDir, readJson, writeJsonAtomic } from "../util/fs.js";
import { routeSegments } from "../util/route.js";

export function preconditionsDir(dataDir: string): string {
  return p(dataDir, "preconditions");
}

export function recipePath(dataDir: string, name: string): string {
  return join(preconditionsDir(dataDir), `${name}.json`);
}

export function listRecipes(dataDir: string): RecipeSummary[] {
  const dir = preconditionsDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: RecipeSummary[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const file = join(dir, f);
    try {
      const r = readJson<Recipe>(file);
      out.push({
        name: r.name ?? basename(f, ".json"),
        description: r.description,
        targetUrl: r.targetUrl,
        shape: recipeShape({ steps: Array.isArray(r.steps) ? r.steps : [], shape: r.shape }),
        finalNavigation: r.finalNavigation,
        createdAt: r.createdAt,
        steps: Array.isArray(r.steps) ? r.steps.length : 0,
        file,
      });
    } catch {
      out.push({ name: basename(f, ".json"), description: "(unreadable)", shape: "navigation", finalNavigation: "", createdAt: "", steps: 0, file });
    }
  }
  return out;
}

/** Mechanical only: how (or whether) a recipe's targetUrl relates to the queried route. */
function matchRoute(recipeTarget: string | undefined, query: string): RecipeMatch | undefined {
  if (!recipeTarget) return undefined;
  const a = routeSegments(recipeTarget).map((s) => s.toLowerCase());
  const b = routeSegments(query).map((s) => s.toLowerCase());
  if (!a.length || !b.length) return undefined;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return a[0] === b[0] ? "section" : undefined;
  return a.length === b.length ? "exact" : "prefix";
}

const RANK: Record<RecipeMatch, number> = { exact: 0, prefix: 1, section: 2, keyword: 3 };

/**
 * Narrow a recipe list without reading any recipe file. Both filters are AND-ed;
 * with neither the input is returned untouched (no `matched` field).
 */
export function filterRecipes(
  recipes: RecipeSummary[],
  q: { targetUrl?: string; match?: string },
): RecipeSummary[] | RecipeMatchResult[] {
  if (!q.targetUrl && !q.match) return recipes;
  const needle = q.match?.trim().toLowerCase();
  const out: RecipeMatchResult[] = [];
  for (const r of recipes) {
    const matched: RecipeMatch[] = [];
    if (q.targetUrl) {
      const m = matchRoute(r.targetUrl, q.targetUrl);
      if (!m) continue;
      matched.push(m);
    }
    if (needle) {
      const hay = `${r.name}\n${r.description ?? ""}\n${r.targetUrl ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) continue;
      matched.push("keyword");
    }
    out.push({ ...r, matched });
  }
  return out.sort((x, y) => {
    const rank = Math.min(...x.matched.map((m) => RANK[m])) - Math.min(...y.matched.map((m) => RANK[m]));
    return rank !== 0 ? rank : (y.createdAt ?? "").localeCompare(x.createdAt ?? "");
  });
}

export function loadRecipe(dataDir: string, name: string): Recipe {
  const file = recipePath(dataDir, name);
  if (!existsSync(file)) throw new CliError("E_NO_RECIPE", `Recipe not found: ${name} (${file})`);
  const r = readJson<Recipe>(file);
  const errors = validateRecipe(r);
  if (errors.length) throw new CliError("E_RECIPE_INVALID", `Recipe ${name} is invalid`, errors);
  // Recipes written before shapes existed, or hand-edited since, still answer "what kind is this?".
  return { ...r, shape: recipeShape(r) };
}

export function saveRecipe(dataDir: string, recipe: Recipe): string {
  const errors = validateRecipe(recipe);
  if (errors.length) throw new CliError("E_RECIPE_INVALID", `Recipe ${recipe.name} is invalid`, errors);
  ensureDir(preconditionsDir(dataDir));
  const file = recipePath(dataDir, recipe.name);
  // Keep the stored shape true to the steps: an Agent that adds an API step to a navigation recipe
  // should not have to remember to update the field by hand.
  writeJsonAtomic(file, { ...recipe, shape: recipeShape(recipe) });
  return file;
}
