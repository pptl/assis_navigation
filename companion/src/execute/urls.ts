import type { NavConfig } from "../types.js";

export function isAbsoluteUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/** Resolve an API path against apiBases[0] (recipes store paths relative to the base). */
export function apiUrl(cfg: NavConfig, url: string): string {
  if (isAbsoluteUrl(url)) return url;
  return new URL(url.replace(/^\/+/, ""), cfg.apiBases[0]).href;
}

/** Resolve an app path against appOrigins[0]. */
export function appUrl(cfg: NavConfig, path: string): string {
  if (isAbsoluteUrl(path)) return path;
  return new URL(path, cfg.appOrigins[0] + "/").href;
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
