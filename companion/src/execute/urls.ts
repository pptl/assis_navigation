import type { NavConfig } from "../types.js";
import { CliError } from "../errors.js";
import { samePath } from "../paths.js";
import { readEvents } from "../store/raw.js";
import { loopbackPortOf, portOverview, type ResolveDeps } from "../util/ports.js";

export function isAbsoluteUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/** Resolve an API path against apiBases[0] (recipes store paths relative to the base). */
export function apiUrl(cfg: NavConfig, url: string): string {
  if (isAbsoluteUrl(url)) return url;
  return new URL(url.replace(/^\/+/, ""), cfg.apiBases[0]).href;
}

/** Resolve an app path against appOrigins[0] — which `withLiveOrigin` has already pointed at the live dev server. */
export function appUrl(cfg: NavConfig, path: string): string {
  if (isAbsoluteUrl(path)) return path;
  return new URL(path, cfg.appOrigins[0] + "/").href;
}

/** Origin of the most recent recording made against one of `candidates`. */
function mostRecentlyRecorded(dataDir: string, candidates: string[]): string | undefined {
  if (candidates.length < 2) return candidates[0];
  const recent = readEvents(dataDir).slice(-200);
  for (let i = recent.length - 1; i >= 0; i--) {
    const origin = recent[i].origin;
    if (origin && candidates.includes(origin)) return origin;
  }
  return candidates[0];
}

/**
 * Where the app is being served right now.
 *
 * The configured origin is only a default from onboarding: the dev server takes whatever port is
 * free, so navigating to a port from config would send the browser to a dead address. The live
 * answer comes from the same resolution the recorder uses — which listening port belongs to this
 * project. A non-loopback origin (an app served from a remote test site) does not move, so it is
 * used as-is. Nothing listening for this project is an error, not a guess: the dev server has to be
 * started before a recipe can drive the app.
 */
export function liveOriginOf(dataDir: string, cfg: NavConfig, deps: ResolveDeps = {}): string {
  const configured = cfg.appOrigins[0];
  if (loopbackPortOf(configured) === undefined) return configured;
  const listening = portOverview(deps);
  const mine = listening.filter((r) => r.dataDir && samePath(r.dataDir, dataDir));
  if (!mine.length) {
    throw new CliError(
      "E_NO_DEV_SERVER",
      `No listening port belongs to this project. Start its dev server (any port), then try again.`,
      {
        configured,
        // Only ports something is known about; the rest of the machine's listeners are noise here.
        listening: listening.filter((r) => r.dataDir).map((r) => ({ port: r.port, pid: r.pid, project: r.dataDir })),
        otherListening: listening.filter((r) => !r.dataDir && r.port >= 1024).map((r) => r.port),
      },
    );
  }
  const scheme = new URL(configured).protocol;
  return mostRecentlyRecorded(dataDir, mine.map((r) => `${scheme}//localhost:${r.port}`)) as string;
}

/**
 * A config whose appOrigins[0] points at the live dev server, so every appUrl() below resolves there.
 * `required: false` keeps the configured origin when nothing can be resolved — for calls that must
 * not fail because the dev server went away (reporting the outcome of an action already performed).
 */
export function withLiveOrigin(dataDir: string, cfg: NavConfig, opts: { required?: boolean } = {}): { cfg: NavConfig; appOrigin: string } {
  let origin: string;
  try {
    origin = liveOriginOf(dataDir, cfg);
  } catch (e) {
    if (opts.required !== false) throw e;
    origin = cfg.appOrigins[0];
  }
  const rest = cfg.appOrigins.filter((o) => o !== origin);
  return { cfg: { ...cfg, appOrigins: [origin, ...rest] }, appOrigin: origin };
}

/** Strip a matching apiBase prefix so recipes stay environment-independent. */
export function relativeToApiBase(cfg: NavConfig, absolute: string): { url: string; external: boolean } {
  for (const base of cfg.apiBases) {
    if (absolute.toLowerCase().startsWith(base.toLowerCase())) return { url: absolute.slice(base.length), external: false };
  }
  return { url: absolute, external: true };
}

export function pathnameOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url.split("?")[0]; }
}
