import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Recipe } from "../recipe.js";
import type { ResolvedStep } from "../execute/resolver.js";
import { CliError } from "../errors.js";
import { p } from "../paths.js";
import { ensureDir, readJson, writeJsonAtomic } from "../util/fs.js";

export interface StorageSnapshot {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

export interface SessionContextState {
  actor: string;
  loggedIn: boolean;
  storageSnapshot?: StorageSnapshot;
}

export interface PendingStep {
  stepIndex: number;
  stepId: string;
  probeRound: 1 | 2;
  contextName: string;
  actor: string;
  ensureContext: boolean;
  resolved?: ResolvedStep;
  issuedAt: string;
  attempt: number;
}

export interface ProbeResult {
  stepId: string;
  call: string;
  fixedParams: string[];
  round1: { status: "ok" | "error"; message?: string };
  round2?: { status: "ok" | "error"; message?: string; duplicateSignal: boolean };
}

export interface SessionFile {
  sessionId: string;
  recipeName: string;
  recipe: Recipe;
  mode: "normal" | "probe";
  status: "running" | "done" | "halted";
  createdAt: string;
  updatedAt: string;
  cursor: { stepIndex: number; probeRound: 1 | 2 };
  pending?: PendingStep;
  captured: Record<string, unknown>;
  /** "METHOD url" → consecutive failure count */
  failures: Record<string, number>;
  contexts: Record<string, SessionContextState>;
  lastContext?: string;
  probeResults: ProbeResult[];
  /** stepId → values used in probe round 1, replayed verbatim in round 2 */
  probeResolved: Record<string, ResolvedStep>;
  log: { at: string; event: string; detail?: unknown }[];
  haltReason?: string;
}

export function sessionsDir(dataDir: string): string {
  return p(dataDir, "sessions");
}

export function sessionPath(dataDir: string, id: string): string {
  return join(sessionsDir(dataDir), `${id}.json`);
}

export function newSessionId(): string {
  return randomBytes(4).toString("hex");
}

export function loadSession(dataDir: string, id: string): SessionFile {
  const file = sessionPath(dataDir, id);
  if (!existsSync(file)) throw new CliError("E_NO_SESSION", `Session ${id} not found (${file}). It may have finished — start a new one with execute-start.`);
  return readJson<SessionFile>(file);
}

export function saveSession(dataDir: string, s: SessionFile): void {
  s.updatedAt = new Date().toISOString();
  ensureDir(sessionsDir(dataDir));
  writeJsonAtomic(sessionPath(dataDir, s.sessionId), s);
}

export function deleteSession(dataDir: string, id: string): void {
  const file = sessionPath(dataDir, id);
  if (existsSync(file)) unlinkSync(file);
}

/** Remove finished/halted/stale session files older than maxAgeHours. */
export function cleanupSessions(dataDir: string, maxAgeHours = 24): string[] {
  const dir = sessionsDir(dataDir);
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  const cutoff = Date.now() - maxAgeHours * 3600_000;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const file = join(dir, f);
    if (statSync(file).mtimeMs < cutoff) { try { unlinkSync(file); removed.push(file); } catch { /* ignore */ } }
  }
  return removed;
}
