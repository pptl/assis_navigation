import { loadConfig } from "../config.js";
import { unroutedDir } from "../paths.js";
import { maintainRaw, pruneRaw, type RawMaintenance } from "../store/raw.js";

/**
 * Keep raw/ bounded from the CLI side too: the native host only prunes when Chrome reconnects, so on
 * a machine where Chrome stays closed yesterday's files would otherwise never go. Never fails the
 * command it rides on.
 */
export function tidyRaw(dataDir: string): { rawMaintenance?: RawMaintenance; rawMaintenanceError?: string } {
  try {
    const recording = loadConfig(dataDir).recording;
    const r = maintainRaw(dataDir, recording);
    // Same reasoning for the staging area, whole-day granularity: both fields express one threshold.
    const hours = recording.unroutedKeepHours;
    r.removed.push(...pruneRaw(unroutedDir(), { bufferHours: hours, unclaimedKeepDays: hours / 24 }));
    return r.removed.length || r.compacted.length ? { rawMaintenance: r } : {};
  } catch (e) {
    return { rawMaintenanceError: e instanceof Error ? e.message : String(e) };
  }
}
