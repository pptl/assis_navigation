// MV3 service worker: bridges page events to the native host.
//
// What gets recorded is decided here and is deliberately coarse — every loopback page, plus any
// extra site the host lists. Which project a recording belongs to is decided by the companion, from
// the process holding the port; this worker never needs to know about ports or projects.
//
// Lifecycle: Chrome may kill this worker whenever the page is idle. Everything that must survive
// (extra origins, pause flag) lives in chrome.storage.local; the native host itself persists all
// recorded data on disk, so a dead worker never loses anything that already left the page.

const HOST_NAME = "com.navrecorder.companion";
const SCRIPT_IDS = { interceptor: "nav-recorder-interceptor", relay: "nav-recorder-relay", interactions: "nav-recorder-interactions" };
// Dev servers get whatever port is free, so ports are never part of the whitelist: every loopback
// page is recorded and the companion works out which project the port belongs to. Match patterns
// carry no port, so one pattern per host covers all of them. state.origins only adds sites that are
// not loopback (an app served from a remote test site).
const LOOPBACK_MATCHES = [
  "http://localhost/*", "https://localhost/*",
  "http://*.localhost/*", "https://*.localhost/*",
  "http://127.0.0.1/*", "https://127.0.0.1/*",
];
const MAX_BUFFER = 200;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 8000;

let port = null;
let backoff = BACKOFF_MIN;
let reconnectTimer = null;
const buffer = [];
let state = { origins: [], paused: false };

const ready = chrome.storage.local.get(["origins", "paused"]).then((s) => {
  state.origins = Array.isArray(s.origins) ? s.origins : [];
  state.paused = !!s.paused;
});

// ---------- origin whitelist → runtime-registered content scripts ----------

async function registerScripts(origins) {
  const ids = Object.values(SCRIPT_IDS);
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  } catch (e) {
    console.warn("[nav-recorder] unregister failed", e);
  }
  const matches = [...LOOPBACK_MATCHES, ...origins.filter((o) => !isLoopbackUrl(o)).map((o) => o.replace(/\/+$/, "") + "/*")];
  try {
    await chrome.scripting.registerContentScripts([
      { id: SCRIPT_IDS.interceptor, js: ["interceptor.js"], matches, runAt: "document_start", world: "MAIN", allFrames: false, persistAcrossSessions: true },
      { id: SCRIPT_IDS.relay, js: ["relay.js"], matches, runAt: "document_start", world: "ISOLATED", allFrames: false, persistAcrossSessions: true },
      { id: SCRIPT_IDS.interactions, js: ["interactions.js"], matches, runAt: "document_start", world: "ISOLATED", allFrames: false, persistAcrossSessions: true },
    ]);
  } catch (e) {
    console.error("[nav-recorder] registerContentScripts failed", e, matches);
  }
}

async function setOrigins(origins) {
  const next = [...new Set((origins || []).filter((o) => typeof o === "string" && /^https?:\/\//.test(o)))];
  state.origins = next;
  await chrome.storage.local.set({ origins: next });
  await registerScripts(next); // always: the loopback patterns must be registered even with an empty list
}

async function setPaused(paused) {
  state.paused = !!paused;
  await chrome.storage.local.set({ paused: state.paused });
}

function isLoopbackUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

function shouldRecord(url) {
  if (isLoopbackUrl(url)) return true;
  try {
    return state.origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

// ---------- native messaging port ----------

function ensurePort() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    console.warn("[nav-recorder] connectNative threw", e);
    port = null;
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err) console.warn("[nav-recorder] host disconnected:", err.message);
    port = null;
    scheduleReconnect();
  });
  port.postMessage({ type: "ident", extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version });
  flush();
}

function scheduleReconnect() {
  if (reconnectTimer || buffer.length === 0) return; // only retry when something is waiting
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
    ensurePort();
  }, backoff);
}

function flush() {
  while (port && buffer.length) {
    const ev = buffer.shift();
    try { port.postMessage(ev); } catch (e) { buffer.unshift(ev); break; }
  }
}

function send(event) {
  if (state.paused) return;
  if (port) {
    try { port.postMessage(event); return; } catch { /* fall through to buffer */ }
  }
  buffer.push(event);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  ensurePort();
}

async function onHostMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "ident-ack":
      backoff = BACKOFF_MIN;
      await setOrigins(msg.origins);
      await setPaused(!!msg.paused);
      flush();
      break;
    case "pause":
      await setPaused(true);
      break;
    case "resume":
      await setPaused(false);
      break;
    default:
      break;
  }
}

// ---------- events from pages ----------

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.__navRecorder !== 1 || !msg.event) return false;
  ready.then(() => {
    const tab = sender.tab;
    if (!tab || tab.active !== true) return; // only the tab the user is looking at
    const tabUrl = tab.url || sender.url || "";
    if (!shouldRecord(tabUrl)) return;
    const ev = msg.event;
    ev.tabId = tab.id;
    ev.tabUrl = tabUrl;
    try { ev.origin = new URL(tabUrl).origin; } catch { return; }
    send(ev);
  });
  return false;
});

// ---------- navigation events ----------

async function onNavigation(details, transition) {
  if (details.frameId !== 0) return;
  await ready;
  if (!shouldRecord(details.url)) return;
  let tab = null;
  try { tab = await chrome.tabs.get(details.tabId); } catch { return; }
  if (!tab || tab.active !== true) return;
  // transitionType ("link" / "typed" / "reload" / ...) lets the companion tell a navigation the user
  // clicked into from one they typed or reloaded — the former is attached to the preceding click.
  send({
    v: 1, type: "navigation", tabId: details.tabId, tabUrl: details.url, origin: new URL(details.url).origin,
    ts: new Date(details.timeStamp || Date.now()).toISOString(), url: details.url, transition,
    transitionType: details.transitionType || undefined, transitionQualifiers: details.transitionQualifiers || [],
  });
}

chrome.webNavigation.onCommitted.addListener((d) => { onNavigation(d, "committed"); });
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => { onNavigation(d, "history"); });

// ---------- startup ----------

async function boot() {
  await ready;
  await registerScripts(state.origins);
  ensurePort(); // fetch the current whitelist from the host
}

chrome.runtime.onInstalled.addListener(() => { boot(); });
chrome.runtime.onStartup.addListener(() => { boot(); });
chrome.action.onClicked.addListener(async () => {
  // Manual poke: reconnect + resync whitelist. Useful right after `nav-recorder init`.
  await ready;
  if (port) { try { port.disconnect(); } catch { /* ignore */ } port = null; }
  ensurePort();
});
