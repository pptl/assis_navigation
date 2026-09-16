import { p } from "../paths.js";
import { readJson, writeJsonAtomic } from "../util/fs.js";

export interface ClaimRecord {
  at: string;
  recipeName: string | null;
  fromSeq: number;
  toSeq: number;
  events: number;
  discarded: boolean;
  /** first seq actually distilled; later than fromSeq when earlier browsing sessions were left out */
  distilledFromSeq?: number;
}

export interface ClaimState {
  /** every event with seq <= lastSeq has been claimed (or discarded) */
  lastSeq: number;
  lastClaimedAt: string | null;
  history: ClaimRecord[];
}

export function loadClaimState(dataDir: string): ClaimState {
  const s = readJson<Partial<ClaimState>>(p(dataDir, "claim-state.json"), {});
  return { lastSeq: s.lastSeq ?? 0, lastClaimedAt: s.lastClaimedAt ?? null, history: s.history ?? [] };
}

export function advanceClaim(dataDir: string, rec: Omit<ClaimRecord, "at">): ClaimState {
  const s = loadClaimState(dataDir);
  s.lastSeq = Math.max(s.lastSeq, rec.toSeq);
  s.lastClaimedAt = new Date().toISOString();
  s.history.push({ at: s.lastClaimedAt, ...rec });
  if (s.history.length > 50) s.history = s.history.slice(-50);
  writeJsonAtomic(p(dataDir, "claim-state.json"), s);
  return s;
}
