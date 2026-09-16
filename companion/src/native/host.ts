import { join } from "node:path";
import type { RecorderEvent, RequestEvent } from "../types.js";
import { loadControl, loadHosts, lookupDataDir } from "../hosts.js";
import { hostLogPath } from "../paths.js";
import { appendEvent, pruneRaw, rawDir, type RetentionPolicy } from "../store/raw.js";
import { DEFAULT_CONFIG } from "../config.js";
import { AuthProvenance } from "../distill/layer2bAuthProvenance.js";
import { FrameParser, encodeFrame } from "./framing.js";
import { FileLogger } from "../util/log.js";
import { readJson } from "../util/fs.js";
import { existsSync } from "node:fs";

interface IdentMessage { type: "ident"; extensionId?: string; version?: string }
type InboundMessage = IdentMessage | RecorderEvent | { type: string; [k: string]: unknown };

const VERSION = "0.1.0";

export function provenancePath(dataDir: string): string {
  return join(rawDir(dataDir), "auth-provenance.json");
}

/** Read straight from config.json with defaults: an invalid config must not stop the host from recording. */
function readRetention(dataDir: string): RetentionPolicy {
  const d = DEFAULT_CONFIG.recording;
  const fallback: RetentionPolicy = { bufferHours: d.bufferHours, unclaimedKeepDays: d.unclaimedKeepDays };
  const cfgPath = join(dataDir, "config.json");
  if (!existsSync(cfgPath)) return fallback;
  try {
    const cfg = readJson<{ recording?: Partial<RetentionPolicy> }>(cfgPath);
    return { bufferHours: cfg.recording?.bufferHours ?? fallback.bufferHours, unclaimedKeepDays: cfg.recording?.unclaimedKeepDays ?? fallback.unclaimedKeepDays };
  } catch {
    return fallback;
  }
}

/**
 * Native messaging host loop. Runs until stdin closes (Chrome disconnects the port).
 * Never writes to stdout except framed messages.
 */
export async function runNativeHost(): Promise<void> {
  const log = new FileLogger(hostLogPath());
  const parser = new FrameParser();
  const provenance = new Map<string, AuthProvenance>();
  const unknownOrigins = new Set<string>();
  let lastPausedSent: boolean | null = null;

  const send = (msg: unknown): void => {
    try {
      process.stdout.write(encodeFrame(msg));
    } catch (e) {
      log.error("stdout write failed", e);
    }
  };

  const getProvenance = (dataDir: string): AuthProvenance => {
    let pv = provenance.get(dataDir);
    if (!pv) {
      pv = AuthProvenance.load(provenancePath(dataDir));
      provenance.set(dataDir, pv);
    }
    return pv;
  };

  const syncPauseState = (): boolean => {
    const paused = loadControl().paused;
    if (lastPausedSent !== paused) {
      send({ type: paused ? "pause" : "resume" });
      lastPausedSent = paused;
    }
    return paused;
  };

  const handleEvent = (ev: RecorderEvent): void => {
    if (syncPauseState()) return;
    if (!ev.origin) {
      try { ev.origin = new URL(ev.tabUrl ?? (ev as RequestEvent).url).origin; } catch { return; }
    }
    const dataDir = lookupDataDir(ev.origin);
    if (!dataDir) {
      if (!unknownOrigins.has(ev.origin)) {
        unknownOrigins.add(ev.origin);
        log.warn("event for unregistered origin ignored", { origin: ev.origin });
      }
      return;
    }
    // Only requests go through auth provenance; navigation and interaction events are stored as-is.
    // Navigation ↔ click attachment happens at read time (distill/trail.ts): the host dies whenever
    // Chrome sleeps the service worker, so cross-event state here would be unreliable.
    if (ev.type === "request") {
      const pv = getProvenance(dataDir);
      const sources = pv.process(ev);
      if (sources.length) ev.authSources = sources;
      pv.save(provenancePath(dataDir));
    }
    appendEvent(dataDir, ev);
  };

  const handleMessage = (msg: InboundMessage): void => {
    if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") return;
    switch (msg.type) {
      case "ident": {
        const hosts = loadHosts();
        const paused = loadControl().paused;
        lastPausedSent = paused;
        send({ type: "ident-ack", origins: Object.keys(hosts.origins), paused, version: VERSION });
        log.info("ident", { extensionId: (msg as IdentMessage).extensionId, origins: Object.keys(hosts.origins) });
        for (const dataDir of new Set(Object.values(hosts.origins))) {
          try {
            const removed = pruneRaw(dataDir, readRetention(dataDir));
            if (removed.length) log.info("pruned raw files", { dataDir, removed });
          } catch (e) {
            log.warn("prune failed", { dataDir, error: String(e) });
          }
        }
        return;
      }
      case "request":
      case "navigation":
      case "interaction":
        handleEvent(msg as RecorderEvent);
        return;
      case "ping":
        send({ type: "pong", paused: loadControl().paused });
        return;
      default:
        log.warn("unknown message type", { type: msg.type });
    }
  };

  log.info("host started", { pid: process.pid, argv: process.argv.slice(2) });

  await new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = parser.push(chunk);
      } catch (e) {
        log.error("frame parse error, exiting", e);
        resolve();
        return;
      }
      for (const m of messages) {
        try {
          handleMessage(m as InboundMessage);
        } catch (e) {
          log.error("message handling failed", e);
        }
      }
    });
    process.stdin.on("end", () => resolve());
    process.stdin.on("close", () => resolve());
    process.stdin.on("error", (e) => { log.error("stdin error", e); resolve(); });
  });

  log.info("host exiting");
}
