import { existsSync } from "node:fs";
import type { RequestEvent } from "../types.js";
import { readJson, writeJsonAtomic } from "../util/fs.js";

/**
 * Layer 2b — auth supply-chain tracking.
 *
 * Maintains "which request produced this token / cookie" so that a later request carrying the
 * artefact marks its producer as must-keep. State is persisted on every update because the host
 * process dies whenever Chrome puts the extension's service worker to sleep.
 */

export interface CookieOrigin {
  requestId: string;
  /** "high" = seen in a Set-Cookie header; "low" = inferred from first appearance in a Cookie header. */
  confidence: "high" | "low";
}

export interface ProvenanceState {
  /** token key (first 32 chars) → requestId whose response body contained it */
  tokens: Record<string, string>;
  cookies: Record<string, CookieOrigin>;
  updatedAt: string;
}

const JWT_RE = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;
const MAX_ENTRIES = 500;
export const TOKEN_KEY_LEN = 32;

export function extractTokens(body: string | null | undefined): string[] {
  if (!body) return [];
  const found = new Set<string>();
  for (const m of body.match(JWT_RE) ?? []) found.add(m.slice(0, TOKEN_KEY_LEN));
  for (const m of body.match(LONG_TOKEN_RE) ?? []) {
    // skip pure-number / pure-date-ish strings and things that are obviously base64 images
    if (/^\d+$/.test(m)) continue;
    if (m.length > 4000) continue;
    found.add(m.slice(0, TOKEN_KEY_LEN));
  }
  return [...found];
}

export function parseCookieNames(cookieHeader: string | undefined): string[] {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((s) => s.trim().split("=")[0])
    .filter((n) => n.length > 0);
}

export function parseSetCookieNames(setCookie: string | undefined): string[] {
  if (!setCookie) return [];
  // Multiple Set-Cookie values may be joined by ", " — split conservatively on "<name>=" boundaries.
  const names: string[] = [];
  for (const part of setCookie.split(/,(?=\s*[^;,=\s]+=)/)) {
    const name = part.trim().split("=")[0];
    if (name && !/^(expires|path|domain|max-age|samesite|secure|httponly)$/i.test(name)) names.push(name);
  }
  return names;
}

function header(h: Record<string, string> | undefined, name: string): string | undefined {
  if (!h) return undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name);
  return key ? h[key] : undefined;
}

export class AuthProvenance {
  private lastRequestId: string | null = null;

  constructor(public state: ProvenanceState = { tokens: {}, cookies: {}, updatedAt: "" }) {}

  static load(path: string): AuthProvenance {
    if (!existsSync(path)) return new AuthProvenance();
    const s = readJson<Partial<ProvenanceState>>(path, {});
    return new AuthProvenance({ tokens: s.tokens ?? {}, cookies: s.cookies ?? {}, updatedAt: s.updatedAt ?? "" });
  }

  save(path: string): void {
    this.state.updatedAt = new Date().toISOString();
    writeJsonAtomic(path, this.state);
  }

  /**
   * Process one request event in arrival order.
   * Returns the requestIds this request depends on for authentication (its "sources").
   */
  process(ev: RequestEvent): string[] {
    const sources = new Set<string>();
    const auth = header(ev.requestHeaders, "authorization");
    const cookie = header(ev.requestHeaders, "cookie");

    if (auth) {
      for (const [key, rid] of Object.entries(this.state.tokens)) {
        if (rid !== ev.requestId && auth.includes(key)) sources.add(rid);
      }
    }
    if (cookie) {
      for (const name of parseCookieNames(cookie)) {
        const origin = this.state.cookies[name];
        if (origin) {
          if (origin.requestId !== ev.requestId) sources.add(origin.requestId);
        } else if (this.lastRequestId && this.lastRequestId !== ev.requestId) {
          // First time we see this cookie name: attribute it to the previous request (low confidence).
          this.state.cookies[name] = { requestId: this.lastRequestId, confidence: "low" };
          sources.add(this.lastRequestId);
        }
      }
    }

    // Register artefacts produced by this response.
    for (const key of extractTokens(ev.responseBody)) {
      if (!(key in this.state.tokens)) this.state.tokens[key] = ev.requestId;
    }
    for (const name of parseSetCookieNames(header(ev.responseHeaders, "set-cookie"))) {
      this.state.cookies[name] = { requestId: ev.requestId, confidence: "high" };
    }
    this.trim();
    this.lastRequestId = ev.requestId;
    return [...sources];
  }

  private trim(): void {
    const tokenKeys = Object.keys(this.state.tokens);
    if (tokenKeys.length > MAX_ENTRIES) {
      for (const k of tokenKeys.slice(0, tokenKeys.length - MAX_ENTRIES)) delete this.state.tokens[k];
    }
    const cookieKeys = Object.keys(this.state.cookies);
    if (cookieKeys.length > MAX_ENTRIES) {
      for (const k of cookieKeys.slice(0, cookieKeys.length - MAX_ENTRIES)) delete this.state.cookies[k];
    }
  }
}
