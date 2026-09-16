import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.js";

export const DATA_DIR_NAME = ".nav-recorder";
/** Default output dir of @playwright/mcp (snapshots, console logs, screenshots) — created in the cwd the MCP server starts in. */
export const PLAYWRIGHT_MCP_DIR_NAME = ".playwright-mcp";
export const HOST_NAME = "com.navrecorder.companion";

/** %USERPROFILE%/.nav-recorder — machine-wide state shared by every project. */
export function globalDir(): string {
  return process.env.NAV_RECORDER_HOME ?? join(homedir(), DATA_DIR_NAME);
}

export function hostsPath(): string { return join(globalDir(), "hosts.json"); }
export function controlPath(): string { return join(globalDir(), "control.json"); }
export function hostDir(): string { return join(globalDir(), "host"); }
export function hostLogPath(): string { return join(globalDir(), "host.log"); }

/** companion/ package root (works from dist/src/*.js). */
export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../companion/dist/src
  return resolve(here, "..", "..");
}

/** Repository root (parent of companion/). */
export function repoRoot(): string {
  return resolve(packageRoot(), "..");
}

export function examplesDir(): string {
  return join(repoRoot(), "examples");
}

export function mainScriptPath(): string {
  return join(packageRoot(), "dist", "src", "main.js");
}

/**
 * Locate the project's .nav-recorder directory.
 * Priority: explicit flag (project dir or the .nav-recorder dir itself) → walk up from cwd.
 */
export function resolveDataDir(explicit?: string, opts: { allowOnboarding?: boolean } = {}): string {
  const marker = (candidate: string): boolean =>
    existsSync(join(candidate, "config.json")) || (!!opts.allowOnboarding && existsSync(join(candidate, "onboarding.json")));
  if (explicit) {
    const abs = resolve(explicit);
    const candidate = basename(abs) === DATA_DIR_NAME ? abs : join(abs, DATA_DIR_NAME);
    if (marker(candidate)) return candidate;
    throw new CliError("E_NO_PROJECT", `No ${DATA_DIR_NAME}/config.json under ${abs}. Run "nav-recorder init" there first.`);
  }
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, DATA_DIR_NAME);
    if (marker(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new CliError(
    "E_NO_PROJECT",
    `Could not find ${DATA_DIR_NAME}/config.json walking up from ${process.cwd()}. Run "nav-recorder init" in the project root, or pass --project <dir>.`,
  );
}

export function projectDirOf(dataDir: string): string {
  return dirname(dataDir);
}

export function p(dataDir: string, ...parts: string[]): string {
  return join(dataDir, ...parts);
}
