// MAIN world, document_start: patches window.fetch and XMLHttpRequest so every API call the page
// makes is reported (request + response) without touching chrome.debugger / DevTools.
(() => {
  if (window.__navRecorderInstalled) return;
  window.__navRecorderInstalled = true;

  const MAX_BODY = 64 * 1024; // keep in sync with config.recording.maxBodyKB default
  const HEADER_ALLOW = /^(authorization|cookie|content-type|accept|x-[a-z0-9-]+)$/i;

  const post = (event) => {
    try { window.postMessage({ __navRecorder: 1, event }, "*"); } catch { /* ignore */ }
  };
  const uuid = () => (crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const absolute = (u) => { try { return new URL(u, location.href).href; } catch { return String(u); } };
  const truncate = (s) => {
    if (typeof s !== "string") return { text: s == null ? null : String(s), truncated: false };
    return s.length > MAX_BODY ? { text: s.slice(0, MAX_BODY), truncated: true } : { text: s, truncated: false };
  };

  function pickHeaders(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof Headers !== "undefined" && h instanceof Headers) {
        h.forEach((v, k) => { if (HEADER_ALLOW.test(k)) out[k.toLowerCase()] = String(v); });
      } else if (Array.isArray(h)) {
        for (const pair of h) { if (pair && HEADER_ALLOW.test(pair[0])) out[String(pair[0]).toLowerCase()] = String(pair[1]); }
      } else if (typeof h === "object") {
        for (const k of Object.keys(h)) { if (HEADER_ALLOW.test(k)) out[k.toLowerCase()] = String(h[k]); }
      }
    } catch { /* ignore */ }
    return out;
  }

  function headersToObject(h) {
    const out = {};
    try { h.forEach((v, k) => { out[k.toLowerCase()] = v; }); } catch { /* ignore */ }
    return out;
  }

  function parseRawHeaders(raw) {
    const out = {};
    if (!raw) return out;
    for (const line of String(raw).split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return out;
  }

  async function bodyToText(body) {
    if (body == null) return null;
    try {
      if (typeof body === "string") return body;
      if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const o = {};
        body.forEach((v, k) => { o[k] = typeof v === "string" ? v : `[File ${v.name || ""} ${v.size || 0}B]`; });
        return JSON.stringify(o);
      }
      if (typeof Blob !== "undefined" && body instanceof Blob) return `[Blob ${body.size}B]`;
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[binary ${body.byteLength}B]`;
      if (typeof body === "object" && typeof body.text === "function") return await body.text();
      return String(body);
    } catch {
      return null;
    }
  }

  // ---------- fetch ----------
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      const started = Date.now();
      const requestId = uuid();
      const isRequest = typeof Request !== "undefined" && input instanceof Request;
      let meta = { url: absolute(isRequest ? input.url : input), method: "GET", requestHeaders: {}, requestBody: null };
      const collect = (async () => {
        try {
          meta.method = String((init && init.method) || (isRequest && input.method) || "GET").toUpperCase();
          meta.requestHeaders = pickHeaders((init && init.headers) || (isRequest ? input.headers : null));
          const body = init && init.body !== undefined ? init.body : (isRequest ? input.clone() : null);
          meta.requestBody = await bodyToText(body);
        } catch { /* keep defaults */ }
      })();

      const result = originalFetch.apply(this, arguments);
      result.then(
        async (res) => {
          // Clone synchronously, before any await: the page's own .then() runs right after this
          // handler yields and may consume the body (res.json()), after which clone() throws and
          // the event would be lost. Headers are read here too for the same reason.
          let cloned = null;
          let bodyError;
          try { cloned = res.clone(); } catch (e) { bodyError = String((e && e.message) || e); }
          const status = res.status;
          const responseHeaders = headersToObject(res.headers);
          await collect;
          let t = { text: null, truncated: false };
          if (cloned) {
            try { t = truncate(await cloned.text()); } catch (e) { bodyError = String((e && e.message) || e); }
          }
          try {
            const ev = {
              v: 1, type: "request", via: "fetch", requestId,
              ts: new Date(started).toISOString(), durationMs: Date.now() - started,
              url: meta.url, method: meta.method, requestHeaders: meta.requestHeaders, requestBody: meta.requestBody,
              status, responseHeaders, responseBody: t.text, responseTruncated: t.truncated,
            };
            if (bodyError) ev.bodyError = bodyError;
            post(ev);
          } catch { /* ignore */ }
        },
        async (err) => {
          await collect;
          post({
            v: 1, type: "request", via: "fetch", requestId,
            ts: new Date(started).toISOString(), durationMs: Date.now() - started,
            url: meta.url, method: meta.method, requestHeaders: meta.requestHeaders, requestBody: meta.requestBody,
            status: 0, responseHeaders: {}, responseBody: null, responseTruncated: false,
            error: String((err && err.message) || err),
          });
        },
      );
      return result;
    };
  }

  // ---------- XMLHttpRequest ----------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setRequestHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      try { this.__nr = { method: String(method || "GET").toUpperCase(), url: absolute(url), headers: {} }; } catch { /* ignore */ }
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (k, v) {
      try { if (this.__nr && HEADER_ALLOW.test(k)) this.__nr.headers[String(k).toLowerCase()] = String(v); } catch { /* ignore */ }
      return setRequestHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const nr = this.__nr;
      if (nr) {
        const started = Date.now();
        const requestId = uuid();
        const bodyPromise = bodyToText(body);
        this.addEventListener("loadend", async () => {
          try {
            const requestBody = await bodyPromise;
            let responseBody = null;
            try {
              responseBody = (this.responseType === "" || this.responseType === "text") ? this.responseText : `[${this.responseType}]`;
            } catch { /* ignore */ }
            const t = truncate(responseBody);
            post({
              v: 1, type: "request", via: "xhr", requestId,
              ts: new Date(started).toISOString(), durationMs: Date.now() - started,
              url: nr.url, method: nr.method, requestHeaders: nr.headers, requestBody,
              status: this.status, responseHeaders: parseRawHeaders(this.getAllResponseHeaders()),
              responseBody: t.text, responseTruncated: t.truncated,
            });
          } catch { /* ignore */ }
        });
      }
      return send.apply(this, arguments);
    };
  }
})();
