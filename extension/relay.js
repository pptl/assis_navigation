// ISOLATED world: forwards events posted by interceptor.js (MAIN world) to the service worker.
// MAIN world scripts cannot reach chrome.runtime, hence the postMessage hop.
(() => {
  if (window.__navRecorderRelay) return;
  window.__navRecorderRelay = true;

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.__navRecorder !== 1 || !data.event) return;
    try {
      chrome.runtime.sendMessage({ __navRecorder: 1, event: data.event }).catch(() => {});
    } catch {
      // extension context invalidated (reloaded) — nothing to do
    }
  });
})();
