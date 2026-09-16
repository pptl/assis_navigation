import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { ActorsFile, NavConfig } from "../types.js";
import { CliError } from "../errors.js";
import { examplesDir, repoRoot } from "../paths.js";
import { preconditionsDir } from "../store/recipes.js";
import { ensureDir, readJson, writeJsonAtomic } from "../util/fs.js";
import { PASSWORD_PLACEHOLDER } from "./state.js";
import { configForDisk } from "../config.js";

export interface ExportResult {
  templateDir: string;
  files: string[];
}

/**
 * Write a reusable template under examples/<name>/: config.json, actors.example.json (passwords
 * scrubbed) and every recipe under preconditions/. Project-specific facts live only here.
 */
export function exportTemplate(dataDir: string, cfg: NavConfig, actors: ActorsFile, name: string, opts: { force?: boolean } = {}): ExportResult {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new CliError("E_USAGE", `Template name must match [A-Za-z0-9._-]+ (got ${name})`);
  const dir = join(examplesDir(), name);
  if (existsSync(join(dir, "config.json")) && !opts.force) {
    throw new CliError("E_EXISTS", `Template ${dir} already exists. Re-run with --force to overwrite it, or --no-export to skip.`);
  }
  ensureDir(join(dir, "preconditions"));
  const files: string[] = [];

  const schemaRel = relative(dir, join(repoRoot(), "schemas", "config.schema.json")).replace(/\\/g, "/");
  const cfgFile = join(dir, "config.json");
  writeJsonAtomic(cfgFile, { $schema: schemaRel, ...configForDisk(cfg) });
  files.push(cfgFile);

  const scrubbed: ActorsFile = { actors: {} };
  for (const [role, a] of Object.entries(actors.actors)) scrubbed.actors[role] = { ...a, password: PASSWORD_PLACEHOLDER };
  const actorsFile = join(dir, "actors.example.json");
  writeJsonAtomic(actorsFile, { $schema: relative(dir, join(repoRoot(), "schemas", "actors.schema.json")).replace(/\\/g, "/"), ...scrubbed });
  files.push(actorsFile);

  const src = preconditionsDir(dataDir);
  if (existsSync(src)) {
    for (const f of readdirSync(src).filter((f) => f.endsWith(".json"))) {
      const recipe = readJson<Record<string, unknown>>(join(src, f));
      delete recipe.source; // claim ranges are machine-specific
      const out = join(dir, "preconditions", f);
      writeJsonAtomic(out, { $schema: relative(join(dir, "preconditions"), join(repoRoot(), "schemas", "recipe.schema.json")).replace(/\\/g, "/"), ...recipe });
      files.push(out);
    }
  }
  return { templateDir: dir, files };
}
