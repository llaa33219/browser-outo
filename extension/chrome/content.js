/*
 * content.js — runs in the isolated world at document_start on every page.
 * Responsibilities:
 *   1. Inject pagehook.js into the page MAIN world so console/error capture
 *      observes the page's own scripts.
 *   2. Buffer console entries (ring buffer, max 500) for get_console.
 *   3. Enumerate interactive elements into window.__outoElements for
 *      list_elements / interact / annotate.
 *   4. Serve DOM-scoped actions requested by the service worker.
 *   5. Ping the service worker every 20s to help keep the MV3 SW alive.
 *
 * Message protocol with background:
 *   inbound:  { target:"content", action:"<name>", params:{...} }
 *   outbound: { ok:true, data:{...} } | { ok:false, error:"..." }
 *   (listener returns true so sendResponse stays open for async work.)
 */

(() => {
  "use strict";

  // The service worker re-injects this file into tabs orphaned by an
  // extension reload; a live instance must not initialise twice.
  if (window.__outoContentInstalled) return;
  window.__outoContentInstalled = true;

  // ------------------------------------------------------------------
  // 1. Pagehook injection (MAIN world)
  // ------------------------------------------------------------------
  function injectPagehook() {
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("pagehook.js");
      s.async = false;
      s.onload = () => { s.remove(); };
      s.onerror = () => { s.remove(); };
      // documentElement always exists at document_start; head/body may not yet.
      (document.head || document.documentElement).appendChild(s);
    } catch (_) { /* page CSP may block — best effort */ }
  }
  injectPagehook();

  // ------------------------------------------------------------------
  // 2. Console ring buffer (fed by pagehook via window.postMessage).
  //    Per-page-load nonce handshake: pagehook must echo back the nonce
  //    we publish via the init message below.
  //
  //    KNOWN LIMITATION: pagehook runs in the page MAIN world, which
  //    shares its JS realm with the page itself. A determined page script
  //    can observe the init postMessage, capture the nonce, and forge
  //    entries that pass this check. This handshake only prevents
  //    accidental collisions and low-effort forgery — it is NOT a
  //    security boundary against the page.
  // ------------------------------------------------------------------
  const MAX_CONSOLE = 500;
  const consoleBuffer = [];
  const outoNonce = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : (String(Math.random()).slice(2) + Date.now().toString(36));

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__outo !== true) return;
    if (d.kind === "console") {
      if (d.nonce !== outoNonce) return; // forged or pre-init entry: drop
      consoleBuffer.push({
        level: d.level,
        text: d.text,
        timestamp: d.ts
      });
      if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.shift();
    }
  });

  // Tell pagehook (MAIN world) the per-load nonce so it can echo it back.
  // Re-send a couple of times to win the load-order race against pagehook's
  // MAIN-world listener (pagehook is idempotent: each init overwrites outoNonce).
  function sendOutoInit() {
    window.postMessage({ __outo: true, kind: "init", nonce: outoNonce }, "*");
  }
  sendOutoInit();
  setTimeout(sendOutoInit, 100);
  setTimeout(sendOutoInit, 500);

  // ------------------------------------------------------------------
  // 3. Element store — stable indices stable until next list_elements.
  // ------------------------------------------------------------------
  window.__outoElements = [];

  // Selectors that mark an element interactive (per spec).
  const INTERACTIVE_SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
    "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
    "[role=textbox]", "[role=combobox]", "[role=listbox]", "[role=tab]",
    "[role=menuitem]",
    "[onclick]", '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'
  ].join(",");

  // Tags whose presence alone means "semantic enough" for the a11y tree.
  const INTERACTIVE_TAGS = new Set([
    "a", "button", "input", "select", "textarea", "summary", "img",
    "video", "audio", "details", "dialog", "canvas"
  ]);

  // ------------------------------------------------------------------
  // Visibility / role helpers
  // ------------------------------------------------------------------
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute("hidden")) return false;
    if (el.disabled) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Implicit ARIA role from tag (explicit role attribute takes priority).
  function implicitRole(el) {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    switch (tag) {
      case "a": return el.hasAttribute("href") ? "link" : null;
      case "button": return "button";
      case "input": {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
        if (t === "range") return "slider";
        if (t === "search") return "searchbox";
        return "textbox";
      }
      case "textarea": return "textbox";
      case "select": return "combobox";
      case "summary": return "button";
      case "img": return el.hasAttribute("usemap") ? "image map" : "image";
      case "nav": return "navigation";
      case "main": return "main";
      case "aside": return "complementary";
      case "header": return "banner";
      case "footer": return "contentinfo";
      case "form": return "form";
      case "search": return "search";
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
      case "ul": case "ol": return "list";
      case "li": return "listitem";
      case "table": return "table";
      case "thead": case "tbody": case "tfoot": return "rowgroup";
      case "tr": return "row";
      case "th": return "columnheader";
      case "td": return "cell";
      case "fieldset": return "group";
      case "datalist": return "listbox";
      case "option": return "option";
      case "optgroup": return "group";
      case "dialog": return "dialog";
      case "details": return "group";
      case "figure": return "figure";
      case "menu": return "menu";
      case "canvas": return "canvas";
      case "video": return "video";
      case "audio": return "audio";
      default: return null;
    }
  }

  // Per frozen spec: name sources are aria-labelledby/aria-label/alt/label/text only.
  // value & placeholder are intentionally excluded here (they're used in elementText).
  function accessibleName(el) {
    if (!el || !el.getAttribute) return "";
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const txt = labelledby.trim().split(/\s+/)
        .map((id) => { const e = document.getElementById(id); return e ? (e.innerText || e.textContent || "").trim() : ""; })
        .filter(Boolean).join(" ");
      if (txt) return txt;
    }
    const al = el.getAttribute("aria-label");
    if (al && al.trim()) return al.trim();
    const alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) { const t = (label.innerText || "").trim(); if (t) return t; }
    }
    const wrapping = el.closest ? el.closest("label") : null;
    if (wrapping) { const t = (wrapping.innerText || "").trim(); if (t) return t; }
    if (typeof el.innerText === "string" && el.innerText.trim()) return el.innerText.trim();
    if (el.textContent && el.textContent.trim()) return el.textContent.trim();
    return "";
  }

  // Text shown for an interactive element in list_elements.
  function elementText(el) {
    // Never expose password values.
    const inputType = el.tagName === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : "";
    if (inputType === "password") return "[password]";
    let t = "";
    if (typeof el.innerText === "string") t = el.innerText;
    if (!t && el.textContent) t = el.textContent;
    // checkbox/radio carry a default value ("on") that is pure noise.
    if (!t && el.value && inputType !== "checkbox" && inputType !== "radio") t = String(el.value);
    if (!t) {
      const al = el.getAttribute("aria-label");
      if (al) t = al;
    }
    if (!t) {
      const ph = el.getAttribute("placeholder");
      if (ph) t = ph;
    }
    if (!t && el.tagName === "INPUT") {
      if (el.id) {
        const lb = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lb) t = (lb.innerText || "").trim();
      }
      if (!t) {
        const wrap = el.closest("label");
        if (wrap) t = (wrap.innerText || "").trim();
      }
      if (!t && inputType !== "hidden") t = `[${inputType}]`;
    }
    return (t || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  // Best-effort unique CSS selector for an element.
  function cssSelector(el) {
    if (el.id && document.getElementById(el.id) === el) {
      return "#" + CSS.escape(el.id);
    }
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 8) {
      let part = node.tagName.toLowerCase();
      if (node.id && document.getElementById(node.id) === node) {
        parts.unshift("#" + CSS.escape(node.id));
        break;
      }
      if (node.name && typeof node.getAttribute === "function" && node.getAttribute("name")) {
        part += '[name="' + CSS.escape(node.getAttribute("name")) + '"]';
      }
      const cls = typeof node.className === "string" ? node.className.trim().split(/\s+/).filter(Boolean) : [];
      if (cls.length) part += cls.slice(0, 3).map((c) => "." + CSS.escape(c)).join("");
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.prototype.filter.call(parent.children, (s) => s.tagName === node.tagName);
        if (sibs.length > 1) {
          const idx = Array.prototype.indexOf.call(sibs, node) + 1;
          part += ":nth-of-type(" + idx + ")";
        }
      }
      parts.unshift(part);
      node = parent;
      depth++;
    }
    return parts.length ? parts.join(" > ") : (el.tagName ? el.tagName.toLowerCase() : "");
  }

  // ------------------------------------------------------------------
  // list_elements
  // ------------------------------------------------------------------
  function listElements() {
    const out = [];
    let raw;
    try {
      raw = document.querySelectorAll(INTERACTIVE_SELECTOR);
    } catch (_) {
      raw = [];
    }
    window.__outoElements = [];
    Array.prototype.forEach.call(raw, (el) => {
      if (!isVisible(el)) return;
      const rect = el.getBoundingClientRect();
      const index = window.__outoElements.length;
      window.__outoElements.push(el);
      out.push({
        index,
        tag: el.tagName.toLowerCase(),
        text: elementText(el),
        role: implicitRole(el) || "generic",
        selector: cssSelector(el),
        bbox: {
          x: Math.round(rect.left * 10) / 10,
          y: Math.round(rect.top * 10) / 10,
          w: Math.round(rect.width * 10) / 10,
          h: Math.round(rect.height * 10) / 10
        }
      });
    });
    return { elements: out };
  }

  // ------------------------------------------------------------------
  // interact
  // ------------------------------------------------------------------
  function scrollIntoView(el) {
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) { el.scrollIntoView(); }
  }

  function setNativeValue(el, text) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      el.innerText = text;
      try {
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      } catch (_) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      // Fallback: write into whatever value/textContent the element has.
      if ("value" in el) {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        el.textContent = text;
      }
    }
  }

  function doInteract(params) {
    const index = params.index | 0;
    const el = window.__outoElements[index];
    if (!el) throw new Error("element index out of range (call list_elements again)");
    const action = params.action;

    scrollIntoView(el);

    if (action === "click") {
      try { el.focus && el.focus(); } catch (_) {}
      // Native click() synthesises a trusted-enough click for most frameworks.
      el.click();
      return { clicked: true };
    }

    if (action === "type") {
      try { el.focus && el.focus(); } catch (_) {}
      setNativeValue(el, String(params.text == null ? "" : params.text));
      return { typed: true };
    }

    if (action === "hover") {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const common = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
      el.dispatchEvent(new MouseEvent("mouseover", common));
      el.dispatchEvent(new MouseEvent("mousemove", common));
      // mouseenter does not bubble.
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: false, view: window, clientX: cx, clientY: cy }));
      return { hovered: true };
    }

    if (action === "select") {
      const value = String(params.value == null ? "" : params.value);
      const opts = el.options ? Array.prototype.slice.call(el.options) : [];
      if (!opts.length) throw new Error("element is not a <select>");
      const match =
        opts.find((o) => o.value === value) ||
        opts.find((o) => (o.text || "").trim() === value);
      if (!match) throw new Error('option "' + value + '" not found');
      el.value = match.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { selected: true };
    }

    throw new Error("unknown interact action: " + action);
  }

  // Full synthetic mouse sequence at viewport coordinates (x, y).
  function doClickXY(params) {
    const x = Number(params.x);
    const y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click_xy requires numeric x and y");
    const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    const hit = stack[0] || document.elementFromPoint(x, y) || document.body || document.documentElement;
    if (!hit) throw new Error("no element at (" + x + ", " + y + ") — point is outside the viewport");
    // elementFromPoint often lands on an inner wrapper (span/div/svg); the
    // meaningful target is the nearest interactive ancestor.
    const interactive = hit.closest
      ? hit.closest('a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [onclick], [contenteditable="true"]')
      : null;
    const el = interactive || hit;
    const common = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
    // Dispatch on the resolved target AND any canvas in the point stack:
    // canvas widgets (CAPTCHA challenges) often listen on the canvas itself
    // even when pointer-events:none hides it from elementFromPoint.
    const targets = [el];
    for (const n of stack) {
      if (n && n.tagName === "CANVAS" && !targets.includes(n)) targets.push(n);
    }
    // Full PointerEvent + MouseEvent sequence in real-browser order: canvas
    // apps (hCaptcha) listen to pointerdown/pointerup, which MouseEvent
    // alone never triggers.
    const SEQ = ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (const t of targets) {
      for (const type of SEQ) {
        const Ctor = type.startsWith("pointer") && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
        t.dispatchEvent(new Ctor(type, common));
      }
      try { t.focus && t.focus(); } catch (_) {}
    }
    if (interactive) {
      // Native click for framework-level handlers; position already conveyed
      // by the mouse events above for coordinate-aware widgets (canvas etc).
      try { el.click(); } catch (_) {}
    }
    return { clicked: true, tag: el.tagName.toLowerCase(), text: elementText(el) };
  }

  function doScroll(params) {
    const dx = Number(params.dx) || 0;
    const dy = Number(params.dy) || 0;
    window.scrollBy(dx, dy);
    return { x: window.scrollX, y: window.scrollY };
  }

  // ------------------------------------------------------------------
  // press_keys — synthesise keydown/keypress/keyup on the active element.
  // ------------------------------------------------------------------
  const KEY_MAP = {
    enter: { key: "Enter", code: "Enter", keyCode: 13 },
    tab: { key: "Tab", code: "Tab", keyCode: 9 },
    escape: { key: "Escape", code: "Escape", keyCode: 27 },
    esc: { key: "Escape", code: "Escape", keyCode: 27 },
    backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    delete: { key: "Delete", code: "Delete", keyCode: 46 },
    del: { key: "Delete", code: "Delete", keyCode: 46 },
    space: { key: " ", code: "Space", keyCode: 32 },
    spacebar: { key: " ", code: "Space", keyCode: 32 },
    arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    home: { key: "Home", code: "Home", keyCode: 36 },
    end: { key: "End", code: "End", keyCode: 35 },
    pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
    pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 }
  };

  function keyInfoFor(name) {
    const lower = name.toLowerCase();
    if (KEY_MAP[lower]) return KEY_MAP[lower];
    const f = /^f([1-9]|1[0-2])$/i.exec(name);
    if (f) {
      const n = parseInt(f[1], 10);
      return { key: "F" + n, code: "F" + n, keyCode: 111 + n };
    }
    if (name.length === 1) {
      const code = name.toUpperCase().charCodeAt(0);
      return { key: name, code: "Key" + name.toUpperCase(), keyCode: code };
    }
    // Unknown — pass through as-is.
    return { key: name, code: name, keyCode: 0 };
  }

  function parseKeyCombo(combo) {
    const parts = String(combo).split("+").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error("empty key combo");
    const keyName = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    return {
      key: keyName,
      ctrl: mods.some((m) => /^(ctrl|control)$/i.test(m)),
      shift: mods.some((m) => /^shift$/i.test(m)),
      alt: mods.some((m) => /^(alt|option|opt)$/i.test(m)),
      meta: mods.some((m) => /^(meta|cmd|command|win|super)$/i.test(m))
    };
  }

  function pressKeys(keys) {
    const parsed = parseKeyCombo(keys);
    const info = keyInfoFor(parsed.key);
    const target = document.activeElement || document.body;
    const common = {
      bubbles: true,
      cancelable: true,
      view: window,
      ctrlKey: parsed.ctrl,
      shiftKey: parsed.shift,
      altKey: parsed.alt,
      metaKey: parsed.meta,
      key: info.key,
      code: info.code,
      // keyCode/which are deprecated but some frameworks read them; the browser
      // may ignore these in the KeyboardEventInit, which is a known limitation.
      keyCode: info.keyCode,
      which: info.keyCode,
      char: info.key.length === 1 ? info.key : ""
    };
    target.dispatchEvent(new KeyboardEvent("keydown", common));
    target.dispatchEvent(new KeyboardEvent("keypress", common));
    target.dispatchEvent(new KeyboardEvent("keyup", common));
    return { pressed: true };
  }

  // ------------------------------------------------------------------
  // get_a11y — simplified accessibility tree as indented plain text.
  // ------------------------------------------------------------------
  function isA11yHidden(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.hasAttribute("hidden")) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return true;
    return false;
  }

  function buildA11yTree() {
    const lines = [];
    const CAP = 50000;
    let len = 0;
    let truncated = false;

    function walk(node, depth) {
      if (truncated || !node || node.nodeType !== 1) return;
      if (isA11yHidden(node)) return;

      const role = implicitRole(node);
      const name = accessibleName(node);
      const tag = node.tagName.toLowerCase();
      const hasRoleAttr = node.hasAttribute("role");
      const hasTabIndex = node.hasAttribute("tabindex");
      const hasAriaLabel = node.hasAttribute("aria-label") || node.hasAttribute("aria-labelledby");
      const interactive = INTERACTIVE_TAGS.has(tag) || node.hasAttribute("onclick") ||
        node.getAttribute && node.getAttribute("contenteditable") === "true";

      // Emit a node if it carries semantic meaning.
      const emit = hasRoleAttr || hasAriaLabel || hasTabIndex || interactive ||
        (role && role !== "generic") || name;

      if (emit) {
        let line = "  ".repeat(depth) + (role || "generic");
        if (name) {
          const safe = name.replace(/"/g, '\\"').slice(0, 120);
          line += ' "' + safe + '"';
        }
        lines.push(line);
        len += line.length + 1;
        if (len > CAP) { truncated = true; return; }
        for (const child of node.children) walk(child, depth + 1);
      } else {
        // Transparent container: descend without increasing depth.
        for (const child of node.children) walk(child, depth);
      }
    }

    const root = document.body || document.documentElement;
    if (root) walk(root, 0);
    let out = lines.join("\n");
    if (truncated) out += "\n... [truncated, tree exceeded 50000 chars]";
    return { tree: out };
  }

  // ------------------------------------------------------------------
  // annotate overlay — draw / remove
  // ------------------------------------------------------------------
  const OVERLAY_ID = "__outo_annotate_overlay";

  function drawAnnotate() {
    // Re-enumerate so the overlay reflects the current DOM (and so
    // window.__outoElements is populated even if list_elements wasn't called).
    const { elements } = listElements();
    removeAnnotate();
    const container = document.createElement("div");
    container.id = OVERLAY_ID;
    container.setAttribute("data-outo", "annotate");
    Object.assign(container.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "100vw",
      height: "100vh",
      pointerEvents: "none",
      zIndex: "2147483647"
    });
    for (const el of elements) {
      const b = el.bbox;
      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "absolute",
        left: b.x + "px",
        top: b.y + "px",
        width: b.w + "px",
        height: b.h + "px",
        border: "2px solid #e53935",
        boxSizing: "border-box"
      });
      const label = document.createElement("div");
      label.textContent = String(el.index);
      Object.assign(label.style, {
        position: "absolute",
        left: "-2px",
        top: "-18px",
        background: "#e53935",
        color: "#fff",
        font: "bold 11px/16px ui-monospace, monospace",
        padding: "0 4px",
        borderRadius: "2px",
        whiteSpace: "nowrap"
      });
      box.appendChild(label);
      container.appendChild(box);
    }
    (document.body || document.documentElement).appendChild(container);
    return { elements };
  }

  function removeAnnotate() {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  // ------------------------------------------------------------------
  // Action dispatcher
  // ------------------------------------------------------------------
  async function handleAction(action, params) {
    switch (action) {
      case "get_html":
        return { html: document.documentElement.outerHTML };

      case "get_console":
        return { entries: consoleBuffer.slice() };

      case "list_elements":
        return listElements();

      case "interact":
        return doInteract(params || {});

      case "press_keys":
        return pressKeys((params || {}).keys || "");

      case "click_xy":
        return doClickXY(params || {});

      case "scroll":
        return doScroll(params || {});

      case "get_a11y":
        return buildA11yTree();

      case "get_viewport":
        return { width: window.innerWidth, height: window.innerHeight };

      case "iframe_rects": {
        // Bounding boxes of direct-child iframes, so the service worker can
        // translate viewport coords into frame-local coords for click_xy.
        const iframes = Array.prototype.map.call(document.querySelectorAll("iframe"), (f) => {
          const r = f.getBoundingClientRect();
          return { src: f.src || "", x: r.left, y: r.top, w: r.width, h: r.height };
        });
        return { iframes: iframes };
      }

      case "go_back":
        window.history.back();
        return { ok_history: true };

      case "go_forward":
        window.history.forward();
        return { ok_history: true };

      case "annotate_draw":
        return drawAnnotate();

      case "annotate_remove":
        removeAnnotate();
        return { removed: true };

      default:
        throw new Error("content: unknown action " + action);
    }
  }

  // ------------------------------------------------------------------
  // Message listener (service worker → content)
  // ------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.target === "content") {
      handleAction(msg.action, msg.params || {})
        .then(
          (data) => { try { sendResponse({ ok: true, data }); } catch (_) {} },
          (err) => {
            const message = (err && err.message) ? err.message : String(err);
            try { sendResponse({ ok: false, error: message }); } catch (_) {}
          }
        );
      return true; // keep the response channel open for the async work above
    }
    // Background may also send a plain ping; acknowledge to reset SW idle timer.
    if (msg && msg.type === "cs_ping_ack") {
      try { sendResponse({ ok: true }); } catch (_) {}
      return false;
    }
    return false;
  });

  // ------------------------------------------------------------------
  // 5. Periodic ping to the service worker (every 20s).
  //    Receiving any runtime message resets the MV3 SW idle timer.
  // ------------------------------------------------------------------
  setInterval(() => {
    try {
      chrome.runtime.sendMessage({ type: "cs_ping" }, () => {
        // Ignore errors (SW may be transiently unavailable).
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }, 20000);
})();
