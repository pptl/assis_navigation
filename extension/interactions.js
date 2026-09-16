// ISOLATED world, document_start: records user interactions (click / Enter / change) so that SPA
// navigation that never changes the URL — switching a top-nav tab, expanding a menu group — still
// leaves a trace. Modelled on Chrome DevTools Recorder: capture-phase listeners, trusted events
// only, target = deepest visible element on the composed path, several alternative selectors per
// step. Navigation is NOT attached here (the host does that at read time from webNavigation).
(() => {
  if (window.__navRecorderInteractions) return;
  window.__navRecorderInteractions = true;

  const TEST_ATTRS = ["data-testid", "data-test", "data-cy", "data-qa", "data-test-id", "data-qa-id"];
  const MAX_TEXT = 120;
  const MAX_NAME = 80;
  const MAX_VALUE = 200;
  const MAX_ANCESTORS = 3;
  const MAX_CSS_DEPTH = 4;
  const TEXT_MIN = 12;
  const TEXT_MAX = 64;

  const send = (event) => {
    try { chrome.runtime.sendMessage({ __navRecorder: 1, event }).catch(() => {}); } catch { /* context invalidated */ }
  };
  const clip = (s, n) => {
    if (s == null) return undefined;
    const t = String(s).replace(/\s+/g, " ").trim();
    if (!t) return undefined;
    return t.length > n ? t.slice(0, n) : t;
  };
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  const uniqueIn = (root, selector, node) => {
    try { const found = root.querySelectorAll(selector); return found.length === 1 && found[0] === node; } catch { return false; }
  };

  // ---------- target ----------
  function targetOf(event) {
    for (const el of event.composedPath()) {
      if (!(el instanceof Element)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      return el;
    }
    return event.target instanceof Element ? event.target : null;
  }

  // ---------- description ----------
  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
      if (t === "checkbox" || t === "radio") return t;
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "button";
    if (tag === "option") return "option";
    if (tag === "li" && el.parentElement && /^(menu|listbox|tablist)$/i.test(el.parentElement.getAttribute("role") || "")) return "menuitem";
    return undefined;
  }
  function roleOf(el) {
    return clip(el.getAttribute("role"), 40) || implicitRole(el);
  }
  function labelledBy(el) {
    const ids = el.getAttribute("aria-labelledby");
    if (!ids) return undefined;
    const parts = [];
    for (const id of ids.split(/\s+/)) {
      const n = el.ownerDocument.getElementById(id);
      if (n) parts.push(n.textContent || "");
    }
    return clip(parts.join(" "), MAX_NAME);
  }
  function accessibleName(el) {
    const tag = el.tagName.toLowerCase();
    return clip(el.getAttribute("aria-label"), MAX_NAME)
      || labelledBy(el)
      || clip(el.getAttribute("title"), MAX_NAME)
      || clip(el.getAttribute("alt"), MAX_NAME)
      || (tag === "input" && /^(submit|button|reset)$/i.test(el.getAttribute("type") || "") ? clip(el.value, MAX_NAME) : undefined)
      || clip(el.innerText, MAX_NAME);
  }
  function testIdOf(el) {
    for (const a of TEST_ATTRS) { const v = el.getAttribute(a); if (v) return { attr: a, value: v }; }
    return undefined;
  }
  function ancestorsOf(el) {
    const out = [];
    let cur = el.parentElement;
    while (cur && out.length < MAX_ANCESTORS) {
      const role = roleOf(cur);
      const label = clip(cur.getAttribute("aria-label"), MAX_NAME) || labelledBy(cur);
      if (role || label) out.push({ tag: cur.tagName.toLowerCase(), role, name: label });
      cur = cur.parentElement;
    }
    return out;
  }
  // Is `name`+`role` enough to single out `el`? Apps sometimes use aria-label as a class-like tag
  // (e.g. every top-nav button sharing one aria-label), which makes the accessible name useless
  // as a selector and as a label — fall back to the visible text in that case.
  function ariaUnique(el, name, role) {
    let count = 0;
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n !== el && (n.contains(el) || el.contains(n))) continue; // wrappers / inner spans repeat the same text
      if (roleOf(n) !== role) continue;
      if (accessibleName(n) === name) { count++; if (count > 1) return false; }
    }
    return count === 1;
  }
  // The element the user meant: the clicked node itself when it has a widget role, else the closest
  // ancestor with one (MUI renders text as <span> inside <div role="button">; Playwright's recorder
  // makes the same promotion when it emits getByRole('button', { name })).
  const WIDGET_ROLES = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "option", "checkbox", "radio", "switch", "combobox"]);
  function interactiveOf(el) {
    let cur = el;
    for (let depth = 0; cur && depth < 5; depth++) {
      const role = roleOf(cur);
      if (role && WIDGET_ROLES.has(role)) return cur;
      cur = cur.parentElement;
    }
    return undefined;
  }
  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const d = { tag };
    try { if (el.id) d.id = clip(el.id, 80); } catch { /* ignore */ }
    try { const n = el.getAttribute("name"); if (n) d.name = clip(n, 80); } catch { /* ignore */ }
    try { const t = el.getAttribute("type"); if (t) d.type = clip(t, 20); } catch { /* ignore */ }
    try { d.role = roleOf(el); } catch { /* ignore */ }
    try { d.accessibleName = accessibleName(el); } catch { /* ignore */ }
    try { d.text = clip(el.innerText, MAX_TEXT); } catch { /* ignore */ }
    try {
      d.nameUnique = d.accessibleName ? ariaUnique(el, d.accessibleName, d.role) : false;
      d.label = (d.nameUnique ? d.accessibleName : undefined) || d.text || d.accessibleName;
    } catch { /* ignore */ }
    try {
      const w = interactiveOf(el);
      if (w && w !== el) {
        const role = roleOf(w);
        const name = accessibleName(w);
        d.interactive = { tag: w.tagName.toLowerCase(), role, name, nameUnique: name ? ariaUnique(w, name, role) : false };
      }
    } catch { /* ignore */ }
    try {
      const a = el.closest("a[href]");
      if (a) d.href = new URL(a.getAttribute("href"), location.href).href;
    } catch { /* ignore */ }
    try { const t = testIdOf(el); if (t) d.testId = t; } catch { /* ignore */ }
    try { d.ancestors = ancestorsOf(el); } catch { /* ignore */ }
    for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
    return d;
  }

  // ---------- selectors ----------
  function cssStep(el, root) {
    const tag = el.tagName.toLowerCase();
    const t = testIdOf(el);
    if (t && uniqueIn(root, `[${t.attr}="${cssEscape(t.value)}"]`, el)) return `[${t.attr}="${cssEscape(t.value)}"]`;
    if (el.id && uniqueIn(root, `#${cssEscape(el.id)}`, el)) return `#${cssEscape(el.id)}`;
    for (const attr of ["name", "aria-label", "role", "href", "type"]) {
      const v = el.getAttribute(attr);
      if (v && v.length <= 100) {
        const s = `${tag}[${attr}="${cssEscape(v)}"]`;
        if (uniqueIn(root, s, el)) return s;
      }
    }
    // nth-of-type among siblings of the same tag
    const parent = el.parentElement;
    if (!parent) return tag;
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag;
  }
  function cssPath(el) {
    const root = el.getRootNode();
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur instanceof Element && depth < MAX_CSS_DEPTH; depth++) {
      parts.unshift(cssStep(cur, root));
      const sel = parts.join(" > ");
      if (uniqueIn(root, sel, el)) return sel;
      cur = cur.parentElement;
    }
    return undefined;
  }
  function textSelector(el) {
    const full = clip(el.innerText, TEXT_MAX + 1);
    if (!full || full.length > TEXT_MAX) return undefined;
    const root = el.getRootNode();
    const matches = (needle) => {
      let count = 0;
      let hit = false;
      const walker = root.ownerDocument ? root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT) : document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n !== el && el.contains(n)) continue; // the target's own descendants repeat its text
        if (n.children.length === 0 || n === el) {
          const t = clip(n.innerText, TEXT_MAX + 1);
          if (t && t.includes(needle)) { count++; if (n === el) hit = true; if (count > 1) return false; }
        }
      }
      return count === 1 && hit;
    };
    if (full.length <= TEXT_MIN) return matches(full) ? `text/${full}` : undefined;
    let best;
    let lo = TEXT_MIN;
    let hi = full.length;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (matches(full.slice(0, mid))) { best = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (best === undefined) return undefined;
    let end = best;
    while (end < full.length && full[end] !== " ") end++;
    return `text/${full.slice(0, end)}`;
  }
  function selectorsOf(el, d) {
    const out = [];
    const push = (s) => { if (s && !out.includes(s)) out.push(s); };
    try { if (d.accessibleName && d.nameUnique) push(d.role ? `aria/${d.accessibleName}[role="${d.role}"]` : `aria/${d.accessibleName}`); } catch { /* ignore */ }
    try { if (d.interactive && d.interactive.name && d.interactive.nameUnique) push(`aria/${d.interactive.name}[role="${d.interactive.role}"]`); } catch { /* ignore */ }
    try { if (d.testId) push(`[${d.testId.attr}="${cssEscape(d.testId.value)}"]`); } catch { /* ignore */ }
    try { if (el.id && uniqueIn(el.getRootNode(), `#${cssEscape(el.id)}`, el)) push(`#${cssEscape(el.id)}`); } catch { /* ignore */ }
    // text before the css path: a short unique text survives layout changes that break nth-of-type chains
    try { push(textSelector(el)); } catch { /* ignore */ }
    try { push(cssPath(el)); } catch { /* ignore */ }
    return out;
  }

  // ---------- events ----------
  function emit(kind, el, extra) {
    const target = describe(el);
    send({
      v: 1, type: "interaction", kind, ts: new Date().toISOString(), pageUrl: location.href,
      target, selectors: selectorsOf(el, target), ...extra,
    });
  }
  const isFormField = (el) => /^(input|textarea|select)$/i.test(el.tagName);

  window.addEventListener("click", (event) => {
    try {
      if (!event.isTrusted || event.detail === 0) return; // keyboard-activated clicks are recorded as key events
      const el = targetOf(event);
      if (!el) return;
      emit("click", el, { button: event.button });
    } catch { /* never break the page */ }
  }, true);

  window.addEventListener("keydown", (event) => {
    try {
      if (!event.isTrusted || event.key !== "Enter") return;
      const el = targetOf(event);
      if (!el || !(isFormField(el) || /^(button|a)$/i.test(el.tagName) || el.getAttribute("role") === "button")) return;
      emit("key", el, { key: "Enter" });
    } catch { /* ignore */ }
  }, true);

  window.addEventListener("change", (event) => {
    try {
      if (!event.isTrusted) return;
      const el = targetOf(event);
      if (!el || !isFormField(el)) return;
      const type = (el.getAttribute("type") || "").toLowerCase();
      let value;
      if (type === "password") value = "***";
      else if (type === "checkbox" || type === "radio") value = el.checked ? "checked" : "unchecked";
      else if (type === "file") value = "[file]";
      else value = clip(el.value, MAX_VALUE) ?? "";
      emit("input", el, { value });
    } catch { /* ignore */ }
  }, true);
})();
