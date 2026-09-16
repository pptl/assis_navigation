import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActorsFile, NavConfig } from "../types.js";
import { DATA_DIR_NAME, PLAYWRIGHT_MCP_DIR_NAME, repoRoot } from "../paths.js";
import { registerOrigins } from "../hosts.js";
import { configForDisk } from "../config.js";
import { writeReadme } from "../store/readme.js";
import { ensureDir, readJson, readText, writeJsonAtomic, writeText } from "../util/fs.js";

/** Create the .nav-recorder/ directory skeleton (idempotent). */
export function scaffoldDataDir(dataDir: string): string[] {
  const created: string[] = [];
  for (const sub of ["preconditions", "raw", "raw/claims", "sessions"]) ensureDir(join(dataDir, sub));
  for (const f of ["data-source-map.json", "param-constraints.json"]) {
    const file = join(dataDir, f);
    if (!existsSync(file)) { writeJsonAtomic(file, { entries: {} }); created.push(file); }
  }
  return created;
}

/** Directories that must never be committed: .nav-recorder/ (credentials + raw traffic) and .playwright-mcp/ (Playwright MCP snapshots / console logs / screenshots written next to the project). */
export const IGNORE_PATTERNS: readonly string[] = [`${DATA_DIR_NAME}/`, `${PLAYWRIGHT_MCP_DIR_NAME}/`];

export interface GitignoreResult {
  /** "added" = at least one line appended now; "present" = every pattern already ignored; "no-git-root" = nothing done, must be handled manually */
  status: "added" | "present" | "no-git-root";
  gitRoot: string | null;
  file: string | null;
  /** every pattern that must be ignored */
  patterns: string[];
  /** patterns appended by this call */
  added: string[];
  /** patterns that were already there */
  present: string[];
  /** true when the git root is above the project directory (monorepo) — worth telling the user which file changed */
  aboveProject: boolean;
}

export function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when `pattern` (a "name/" directory pattern) is already covered by a line in the .gitignore at `file`. */
export function gitignoreHas(file: string, pattern = `${DATA_DIR_NAME}/`): boolean {
  if (!existsSync(file)) return false;
  const bare = pattern.replace(/\/$/, "");
  const accepted = new Set([pattern, bare, `**/${pattern}`, `/${pattern}`, `**/${bare}`, `/${bare}`]);
  const text = readText(file);
  return text.split(/\r?\n/).some((l) => accepted.has(l.trim()));
}

/** Walk up from projectDir to the nearest git root; add every IGNORE_PATTERNS entry that is missing to its .gitignore (matches at any depth). */
export function ensureGitignore(projectDir: string, patterns: readonly string[] = IGNORE_PATTERNS): GitignoreResult {
  const all = [...patterns];
  const gitRoot = findGitRoot(projectDir);
  if (!gitRoot) return { status: "no-git-root", gitRoot: null, file: null, patterns: all, added: [], present: [], aboveProject: false };
  const gi = join(gitRoot, ".gitignore");
  const aboveProject = gitRoot !== projectDir;
  const present = all.filter((p) => gitignoreHas(gi, p));
  const added = all.filter((p) => !present.includes(p));
  if (added.length === 0) return { status: "present", gitRoot, file: gi, patterns: all, added, present, aboveProject };
  const lines = added.map((p) => `${p}\n`).join("");
  if (existsSync(gi)) {
    const text = readText(gi);
    writeText(gi, text.endsWith("\n") || text.length === 0 ? `${text}${lines}` : `${text}\n${lines}`);
  } else {
    writeText(gi, lines);
  }
  return { status: "added", gitRoot, file: gi, patterns: all, added, present, aboveProject };
}

export function writeConfigFile(dataDir: string, cfg: NavConfig): string {
  const file = join(dataDir, "config.json");
  writeJsonAtomic(file, { $schema: pathToFileURL(join(repoRoot(), "schemas", "config.schema.json")).href, ...configForDisk(cfg) });
  return file;
}

export function readActorsFile(dataDir: string): ActorsFile | undefined {
  const file = join(dataDir, "actors.json");
  if (!existsSync(file)) return undefined;
  const a = readJson<ActorsFile>(file, { actors: {} });
  return { actors: a.actors ?? {} };
}

export function writeActorsFile(dataDir: string, actors: ActorsFile): string {
  const file = join(dataDir, "actors.json");
  writeJsonAtomic(file, actors);
  return file;
}

/** Everything that must happen after config.json exists: README, gitignore, origin registration. */
export function finishScaffold(dataDir: string, projectDir: string, cfg: NavConfig): { created: string[]; origins: Record<string, string>; gitignore: GitignoreResult } {
  const created: string[] = [];
  created.push(writeReadme(cfg, dataDir));
  const gitignore = ensureGitignore(projectDir);
  if (gitignore.status === "added" && gitignore.file) created.push(gitignore.file);
  const hosts = registerOrigins(cfg.appOrigins, dataDir);
  return { created, origins: hosts.origins, gitignore };
}
