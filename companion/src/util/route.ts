/**
 * Normalise a route to its comparable path form: `/A/B`.
 * Accepts a bare path or a full URL. Case is preserved — `data-source-map.json`
 * keys are stored in the app's own casing and lower-casing here would orphan them.
 */
export function normRoute(route: string): string {
  let r = route.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(r)) {
    try { r = new URL(r).pathname; } catch { /* not a URL after all — treat as a path */ }
  }
  r = r.split("?")[0].split("#")[0];
  return (r.startsWith("/") ? r : `/${r}`).replace(/\/+$/, "") || "/";
}

/** Path segments of a normalised route: `/Order/DispatchFirst` → ["Order", "DispatchFirst"]. */
export function routeSegments(route: string): string[] {
  return normRoute(route).split("/").filter(Boolean);
}
