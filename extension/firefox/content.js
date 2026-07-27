/*
 * content.js — content script for browser-outo (Firefox MV2).
 *
 * Responsibilities:
 *   1. Inject pagehook.js into the page MAIN world at document_start so
 *      console + global errors are captured.
 *   2. Buffer the captured console entries in a 500-entry ring per tab.
 *   3. Receive {target:"content", action, params} messages from background.js
 *      and dispatch them to DOM handlers, returning {ok, data} or {ok:false, error}.
 *
 * Runs in the content-script isolated world: shares DOM with the page but has
 * its own JS globals, so window.__outoElements below is NOT visible to page code.
 */
(function () {
  "use strict";

  // The background page re-injects this file into tabs orphaned by an
  // extension reload; a live instance must not initialise twice.
  if (window.__outoContentInstalled) return;
  window.__outoContentInstalled = true;

  // ---------------------------------------------------------------- console buffer

  var CONSOLE_MAX = 500;
  var consoleEntries = [];

  function pushConsoleEntry(level, text, timestamp) {
    consoleEntries.push({ level: level, text: text, timestamp: timestamp });
    while (consoleEntries.length > CONSOLE_MAX) {
      consoleEntries.shift();
    }
  }

  // Listen for messages from pagehook.js (posted from page MAIN world).
  window.addEventListener("message", function (event) {
    if (event.source !== window) {
      return;
    }
    var data = event.data;
    if (!data || data.__outo !== true) {
      return;
    }
    pushConsoleEntry(data.level, data.text, data.timestamp || Date.now());
  });

  // Some console output may happen before the pagehook lands (very rare with
  // document_start injection, but cover it anyway): also buffer from our own
  // runtime onMessage path if needed. Page errors captured by Firefox's
  // webNavigation are out of scope here.

  // ---------------------------------------------------------------- pagehook injection

  function injectPagehook() {
    try {
      // The hook is one-shot (guards against re-install). Re-injecting after a
      // SPA soft-navigation is a no-op, which is the desired behavior.
      var script = document.createElement("script");
      script.src = browser.runtime.getURL("pagehook.js");
      script.async = false;
      // Remove once executed so it doesn't clutter the DOM inspector.
      script.onload = function () { script.remove(); };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      // about:blank or XML docs may not allow script injection — ignore.
    }
  }

  injectPagehook();
  // Re-inject onreadystatechange is unnecessary: pagehook guards itself.

  // ---------------------------------------------------------------- element store
  //
  // list_elements stashes the matched live DOM nodes here so a follow-up
  // interact {index} call can find them by position without re-querying.
  // Index is stable only until the next list_elements call.

  var storedElements = [];

  // ---------------------------------------------------------------- helpers

  var INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=textbox]",
    "[role=combobox]",
    "[role=listbox]",
    "[role=tab]",
    "[role=menuitem]",
    "[onclick]",
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(", ");

  /**
   * True if the element is plausibly visible to a human: non-zero box,
   * not display:none / visibility:hidden / opacity:0, and not disabled.
   */
  function isVisible(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    if (el.disabled) {
      return false;
    }
    // Off-screen via hidden attribute or aria-hidden: skip.
    if (el.hasAttribute("hidden")) {
      return false;
    }
    var rect;
    try {
      rect = el.getBoundingClientRect();
    } catch (e) {
      return false;
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    var style;
    try {
      style = window.getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (!style) {
      return false;
    }
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }
    var opacity = parseFloat(style.opacity);
    if (!isNaN(opacity) && opacity <= 0) {
      return false;
    }
    return true;
  }

  /**
   * Best-effort unique CSS selector for an element. Tries id first, then
   * builds a tag+nth-of-type path up to the body, capped at 6 levels.
   * Never throws; falls back to a tag[index] form.
   */
  function cssSelector(el) {
    try {
      if (el.id) {
        var id = CSS.escape(el.id);
        // Make sure the id is actually unique in the document.
        if (document.querySelectorAll("#" + id).length === 1) {
          return "#" + id;
        }
      }
      var parts = [];
      var node = el;
      var depth = 0;
      while (node && node.nodeType === 1 && depth < 6) {
        var tag = node.tagName.toLowerCase();
        var part = tag;
        if (node.id) {
          part += "#" + CSS.escape(node.id);
          parts.unshift(part);
          break;
        }
        var parent = node.parentElement;
        if (parent) {
          var siblings = Array.prototype.filter.call(parent.children, function (s) {
            return s.tagName === node.tagName;
          });
          if (siblings.length > 1) {
            var index = Array.prototype.indexOf.call(siblings, node) + 1;
            part += ":nth-of-type(" + index + ")";
          }
        }
        parts.unshift(part);
        node = parent;
        depth++;
      }
      return parts.join(" > ");
    } catch (e) {
      // Last-resort fallback.
      var all = document.getElementsByTagName(el.tagName || "*");
      for (var i = 0; i < all.length; i++) {
        if (all[i] === el) {
          return (el.tagName || "el").toLowerCase() + "[" + i + "]";
        }
      }
      return (el.tagName || "el").toLowerCase();
    }
  }

  function visibleText(el, maxLen) {
    var max = typeof maxLen === "number" ? maxLen : 120;
    var text;
    try {
      // textContent is more reliable than innerText (no layout reflow).
      text = (el.textContent || el.innerText || "").replace(/\s+/g, " ").trim();
    } catch (e) {
      text = "";
    }
    if (text.length > max) {
      text = text.slice(0, max);
    }
    return text;
  }

  function roleOf(el) {
    if (el.hasAttribute && el.hasAttribute("role")) {
      var explicit = el.getAttribute("role").trim().split(/\s+/)[0];
      if (explicit) {
        return explicit;
      }
    }
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    switch (tag) {
      case "a": return el.hasAttribute("href") ? "link" : null;
      case "button": return "button";
      case "input":
        var type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button" || type === "reset") return "button";
        if (type === "range") return "slider";
        return "textbox";
      case "select": return "combobox";
      case "textarea": return "textbox";
      case "summary": return "button";
      case "img": return "img";
      case "nav": return "navigation";
      case "main": return "main";
      case "header": return "banner";
      case "footer": return "contentinfo";
      case "form": return "form";
      case "ul":
      case "ol": return "list";
      case "li": return "listitem";
      case "table": return "table";
      case "tr": return "row";
      case "th": return "columnheader";
      case "td": return "cell";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": return "heading";
      case "dialog": return "dialog";
      case "section": return "region";
      default: return null;
    }
  }

  // ---------------------------------------------------------------- actions: DOM

  function doGetHtml() {
    return { ok: true, data: { html: document.documentElement.outerHTML } };
  }

  function doGetConsole() {
    return { ok: true, data: { entries: consoleEntries.slice() } };
  }

  function doListElements() {
    var matches = [];
    try {
      matches = Array.prototype.slice.call(document.querySelectorAll(INTERACTIVE_SELECTOR));
    } catch (e) {
      matches = [];
    }
    var out = [];
    var fresh = [];
    for (var i = 0; i < matches.length; i++) {
      var el = matches[i];
      if (!isVisible(el)) {
        continue;
      }
      var rect = el.getBoundingClientRect();
      var entry = {
        index: out.length,
        tag: el.tagName.toLowerCase(),
        text: visibleText(el, 120),
        role: roleOf(el) || "",
        selector: cssSelector(el),
        bbox: {
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height
        }
      };
      out.push(entry);
      fresh.push(el);
    }
    storedElements = fresh;
    // Also expose to page world (debugging convenience; harmless).
    try {
      window.__outoElements = fresh;
    } catch (e) { /* ignore */ }
    return { ok: true, data: { elements: out } };
  }

  function getStored(index) {
    if (index < 0 || index >= storedElements.length) {
      return null;
    }
    // Re-validate the stored node is still in the document.
    var el = storedElements[index];
    if (!el || !el.isConnected) {
      return null;
    }
    return el;
  }

  function scrollIntoViewSafe(el) {
    try {
      el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    } catch (e) {
      try { el.scrollIntoView(); } catch (e2) { /* ignore */ }
    }
  }

  function dispatchMouse(el, type, related) {
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      detail: 0,
      screenX: Math.round(cx),
      screenY: Math.round(cy),
      clientX: Math.round(cx),
      clientY: Math.round(cy),
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      button: 0,
      buttons: type === "mouseup" ? 0 : 1,
      relatedTarget: related || null
    });
    el.dispatchEvent(ev);
  }

  function doClick(el) {
    scrollIntoViewSafe(el);
    // Hover sequence first so :hover styles apply, then click.
    dispatchMouse(el, "mouseover");
    dispatchMouse(el, "mouseenter");
    dispatchMouse(el, "mousemove");
    dispatchMouse(el, "mousedown");
    dispatchMouse(el, "mouseup");
    dispatchMouse(el, "click");
    // Some sites require a focus before their click handler reads focus.
    try { el.focus && el.focus(); } catch (e) { /* ignore */ }
    return { ok: true, data: { clicked: true } };
  }

  function doHover(el) {
    scrollIntoViewSafe(el);
    dispatchMouse(el, "mouseover");
    dispatchMouse(el, "mouseenter");
    dispatchMouse(el, "mousemove");
    return { ok: true, data: { hovered: true } };
  }

  function doType(el, text) {
    if (text === undefined || text === null) {
      return { ok: false, error: "type action requires 'text'" };
    }
    var value = String(text);
    scrollIntoViewSafe(el);
    try { el.focus && el.focus(); } catch (e) { /* ignore */ }

    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    var editable = el.isContentEditable ||
      el.getAttribute && el.getAttribute("contenteditable") === "true";

    if (tag === "input" || tag === "textarea" || tag === "select") {
      // Use the native value setter on the prototype so frameworks (React)
      // that monkey-patch value via their own tracked descriptor still see
      // the change as a user-driven value mutation.
      var proto = tag === "textarea"
        ? window.HTMLTextAreaElement.prototype
        : tag === "select"
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) {
        setter.set.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (editable) {
      // contenteditable: assign text + dispatch input.
      if ("innerText" in el) {
        el.innerText = value;
      } else if ("textContent" in el) {
        el.textContent = value;
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    } else {
      // Last resort: try to set value anyway.
      try {
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (e) {
        return { ok: false, error: "element is not a text input or contenteditable" };
      }
    }
    return { ok: true, data: { typed: true } };
  }

  function doSelect(el, params) {
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag !== "select") {
      // For [role=listbox] / [role=combobox] built on divs we fall back to click.
      return doClick(el);
    }
    var target = params && (params.value !== undefined ? params.value : params.text);
    var matchByText = params && params.text !== undefined ? String(params.text) : null;
    var matchByValue = params && params.value !== undefined ? String(params.value) : null;
    var options = el.options || [];
    var found = -1;
    for (var i = 0; i < options.length; i++) {
      var opt = options[i];
      var optText = (opt.textContent || "").trim();
      var optVal = opt.value;
      if ((matchByValue !== null && optVal === matchByValue) ||
          (matchByText !== null && optText === matchByText)) {
        found = i;
        break;
      }
    }
    if (found === -1 && target !== undefined) {
      // Looser fallback: substring match.
      var needle = String(target);
      for (var j = 0; j < options.length; j++) {
        var t = (options[j].textContent || "").trim();
        var v = options[j].value;
        if (t.indexOf(needle) !== -1 || v.indexOf(needle) !== -1) {
          found = j;
          break;
        }
      }
    }
    if (found === -1) {
      return { ok: false, error: "no matching option" };
    }
    var proto = window.HTMLSelectElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    el.selectedIndex = found;
    if (setter && setter.set) {
      setter.set.call(el, options[found].value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, data: { selected: true } };
  }

  function doInteract(params) {
    if (!params || typeof params.index !== "number") {
      return { ok: false, error: "interact requires numeric 'index'" };
    }
    var el = getStored(params.index);
    if (!el) {
      return { ok: false, error: "element index out of range (call list_elements again)" };
    }
    var action = params.action;
    switch (action) {
      case "click": return doClick(el);
      case "type": return doType(el, params.text);
      case "hover": return doHover(el);
      case "select": return doSelect(el, params);
      default: return { ok: false, error: "unknown interact action: " + action };
    }
  }

  // ---------------------------------------------------------------- actions: press_keys

  var MODIFIER_NAMES = { control: true, ctrl: true, shift: true, alt: true, option: true, meta: true, command: true, cmd: true };
  // Map a single key token (e.g. "K", "Enter", "F5") to {key, code, keyCode}.
  function resolveKey(token) {
    var raw = String(token).trim();
    if (!raw) {
      return null;
    }
    var normalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    // Modifier single keys
    var upper = raw.toUpperCase();
    var isLetter = /^[A-Z]$/.test(upper);
    var isDigit = /^[0-9]$/.test(raw);

    var key, code, keyCode;

    switch (upper) {
      case "CONTROL":
      case "CTRL":
        key = "Control"; code = "ControlLeft"; keyCode = 17; break;
      case "SHIFT":
        key = "Shift"; code = "ShiftLeft"; keyCode = 16; break;
      case "ALT":
      case "OPTION":
        key = "Alt"; code = "AltLeft"; keyCode = 18; break;
      case "META":
      case "COMMAND":
      case "CMD":
      case "SUPER":
      case "WIN":
        key = "Meta"; code = "MetaLeft"; keyCode = 91; break;
      case "ENTER":
      case "RETURN":
        key = "Enter"; code = "Enter"; keyCode = 13; break;
      case "TAB":
        key = "Tab"; code = "Tab"; keyCode = 9; break;
      case "ESCAPE":
      case "ESC":
        key = "Escape"; code = "Escape"; keyCode = 27; break;
      case "BACKSPACE":
        key = "Backspace"; code = "Backspace"; keyCode = 8; break;
      case "DELETE":
        key = "Delete"; code = "Delete"; keyCode = 46; break;
      case "SPACE":
      case "SPACEBAR":
        key = " "; code = "Space"; keyCode = 32; break;
      case "ARROWUP":
      case "UP":
        key = "ArrowUp"; code = "ArrowUp"; keyCode = 38; break;
      case "ARROWDOWN":
      case "DOWN":
        key = "ArrowDown"; code = "ArrowDown"; keyCode = 40; break;
      case "ARROWLEFT":
      case "LEFT":
        key = "ArrowLeft"; code = "ArrowLeft"; keyCode = 37; break;
      case "ARROWRIGHT":
      case "RIGHT":
        key = "ArrowRight"; code = "ArrowRight"; keyCode = 39; break;
      case "HOME":
        key = "Home"; code = "Home"; keyCode = 36; break;
      case "END":
        key = "End"; code = "End"; keyCode = 35; break;
      case "PAGEUP":
        key = "PageUp"; code = "PageUp"; keyCode = 33; break;
      case "PAGEDOWN":
        key = "PageDown"; code = "PageDown"; keyCode = 34; break;
      default:
        if (isLetter) {
          key = upper; code = "Key" + upper; keyCode = upper.charCodeAt(0);
        } else if (isDigit) {
          key = raw; code = "Digit" + raw; keyCode = raw.charCodeAt(0);
        } else if (/^F([1-9]|1[0-2])$/.test(upper)) {
          key = upper; code = "F" + upper.slice(1); keyCode = 111 + parseInt(upper.slice(1), 10);
        } else {
          // Punctuation / unknown: use the literal character.
          key = raw; code = ""; keyCode = raw.charCodeAt(0) || 0;
        }
    }
    return { key: key, code: code, keyCode: keyCode };
  }

  function isModifierToken(token) {
    var u = String(token).trim().toUpperCase();
    return MODIFIER_NAMES[u.toLowerCase()];
  }

  function doPressKeys(params) {
    var keysStr = params && params.keys;
    if (typeof keysStr !== "string" || !keysStr.trim()) {
      return { ok: false, error: "press_keys requires non-empty 'keys'" };
    }
    // Split on '+' but allow a literal '+' to be expressed as "Plus".
    var normalized = keysStr.replace(/\bPlus\b/gi, "+");
    var tokens = normalized.split("+").map(function (t) { return t.trim(); }).filter(Boolean);
    if (!tokens.length) {
      return { ok: false, error: "could not parse keys: " + keysStr };
    }
    var modifiers = [];
    var finalKey = null;
    for (var i = 0; i < tokens.length; i++) {
      if (isModifierToken(tokens[i])) {
        modifiers.push(resolveKey(tokens[i]));
      } else if (!finalKey) {
        finalKey = resolveKey(tokens[i]);
      } else {
        // Multi non-modifier tokens: emit as a sequence by ignoring extras
        // but treat the rest as separate presses is overkill — error out.
        return { ok: false, error: "press_keys supports one non-modifier key; got multiple" };
      }
    }
    if (!finalKey) {
      // Only modifiers: synthesize a press on the modifier alone.
      if (!modifiers.length) {
        return { ok: false, error: "no keys parsed" };
      }
      finalKey = modifiers[modifiers.length - 1];
      modifiers = modifiers.slice(0, -1);
    }

    var ctrl = modifiers.some(function (m) { return m.key === "Control"; });
    var shift = modifiers.some(function (m) { return m.key === "Shift"; });
    var alt = modifiers.some(function (m) { return m.key === "Alt"; });
    var meta = modifiers.some(function (m) { return m.key === "Meta"; });

    var target = document.activeElement || document.body;
    if (!target) {
      target = document.body;
    }

    function fire(type) {
      var ev = new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        key: finalKey.key,
        code: finalKey.code || "",
        keyCode: finalKey.keyCode || 0,
        which: finalKey.keyCode || 0,
        ctrlKey: ctrl,
        shiftKey: shift,
        altKey: alt,
        metaKey: meta,
        location: 0,
        repeat: false
      });
      target.dispatchEvent(ev);
    }

    fire("keydown");
    fire("keypress");
    fire("keyup");
    return { ok: true, data: { pressed: true } };
  }

  // ---------------------------------------------------------------- actions: annotate

  var ANNOTATE_ID = "__outo_annotate_overlay__";

  function annotateDraw() {
    // Use the current stored elements if present, otherwise re-enumerate.
    var result = doListElements();
    if (!result.ok) {
      return result;
    }
    var elements = result.data.elements;

    // Remove any prior overlay (e.g. previous annotate call without clear).
    annotateClear();

    var overlay = document.createElement("div");
    overlay.id = ANNOTATE_ID;
    overlay.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "width:" + window.innerWidth + "px",
      "height:" + window.innerHeight + "px",
      "z-index:2147483647",
      "pointer-events:none",
      "margin:0",
      "padding:0",
      "background:transparent"
    ].join(";");

    for (var i = 0; i < elements.length; i++) {
      var e = elements[i];
      if (e.bbox.w <= 0 || e.bbox.h <= 0) {
        continue;
      }
      var box = document.createElement("div");
      box.style.cssText = [
        "position:absolute",
        "left:" + e.bbox.x + "px",
        "top:" + e.bbox.y + "px",
        "width:" + e.bbox.w + "px",
        "height:" + e.bbox.h + "px",
        "border:2px solid #e00",
        "box-sizing:border-box"
      ].join(";");
      var label = document.createElement("div");
      label.textContent = String(e.index);
      label.style.cssText = [
        "position:absolute",
        "top:-14px",
        "left:-2px",
        "background:#e00",
        "color:#fff",
        "font:11px/14px monospace",
        "padding:0 3px",
        "border-radius:2px",
        "white-space:nowrap"
      ].join(";");
      box.appendChild(label);
      overlay.appendChild(box);
    }

    // Append to documentElement (not body) so we attach even on pages whose
    // <body> is not yet ready (e.g. partially loaded docs).
    (document.documentElement || document.body).appendChild(overlay);

    return { ok: true, data: { elements: elements } };
  }

  function annotateClear() {
    var existing = document.getElementById(ANNOTATE_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    return { ok: true, data: { cleared: true } };
  }

  // ---------------------------------------------------------------- actions: history

  function doHistoryBack() {
    try {
      window.history.back();
      return { ok: true, data: { ok_history: true } };
    } catch (e) {
      return { ok: false, error: "history.back failed: " + e.message };
    }
  }

  function doHistoryForward() {
    try {
      window.history.forward();
      return { ok: true, data: { ok_history: true } };
    } catch (e) {
      return { ok: false, error: "history.forward failed: " + e.message };
    }
  }

  // ---------------------------------------------------------------- actions: coordinate click / scroll

  function doClickXY(params) {
    var x = Number(params && params.x);
    var y = Number(params && params.y);
    if (!isFinite(x) || !isFinite(y)) {
      return { ok: false, error: "click_xy requires numeric x and y" };
    }
    var stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    var hit = stack[0] || document.elementFromPoint(x, y) || document.body || document.documentElement;
    if (!hit) {
      return { ok: false, error: "no element at (" + x + ", " + y + ") — point is outside the viewport" };
    }
    // elementFromPoint often lands on an inner wrapper (span/div/svg); the
    // meaningful target is the nearest interactive ancestor.
    var interactive = hit.closest
      ? hit.closest('a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [onclick], [contenteditable="true"]')
      : null;
    var el = interactive || hit;
    var common = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
    // Dispatch on the resolved target AND any canvas in the point stack:
    // canvas widgets (CAPTCHA challenges) often listen on the canvas itself
    // even when pointer-events:none hides it from elementFromPoint.
    var targets = [el];
    stack.forEach(function (n) {
      if (n && n.tagName === "CANVAS" && targets.indexOf(n) === -1) targets.push(n);
    });
    // Full PointerEvent + MouseEvent sequence in real-browser order: canvas
    // apps (hCaptcha) listen to pointerdown/pointerup, which MouseEvent
    // alone never triggers.
    var SEQ = ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    targets.forEach(function (t) {
      SEQ.forEach(function (type) {
        var Ctor = type.indexOf("pointer") === 0 && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
        t.dispatchEvent(new Ctor(type, common));
      });
      try { if (t.focus) t.focus(); } catch (e) {}
    });
    if (interactive) {
      try { el.click(); } catch (e) {}
    }
    return { ok: true, data: { clicked: true, tag: el.tagName.toLowerCase(), text: visibleText(el, 120) } };
  }

  function doScroll(params) {
    var dx = Number(params && params.dx) || 0;
    var dy = Number(params && params.dy) || 0;
    window.scrollBy(dx, dy);
    return { ok: true, data: { x: window.scrollX, y: window.scrollY } };
  }

  // Bounding boxes of direct-child iframes, so the background page can
  // translate viewport coords into frame-local coords for click_xy.
  function doIframeRects() {
    var iframes = Array.prototype.map.call(document.querySelectorAll("iframe"), function (f) {
      var r = f.getBoundingClientRect();
      return { src: f.src || "", x: r.left, y: r.top, w: r.width, h: r.height };
    });
    return { ok: true, data: { iframes: iframes } };
  }

  // ---------------------------------------------------------------- actions: a11y tree

  function isA11yHidden(el) {
    if (!el || el.nodeType !== 1) {
      return true;
    }
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") {
      return true;
    }
    if (el.hasAttribute && el.hasAttribute("hidden")) {
      return true;
    }
    var style;
    try {
      style = window.getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (!style) {
      return false;
    }
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return true;
    }
    var opacity = parseFloat(style.opacity);
    if (!isNaN(opacity) && opacity <= 0) {
      return true;
    }
    return false;
  }

  function accessibleName(el) {
    // aria-labelledby takes highest precedence.
    var labelledby = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledby) {
      var ids = labelledby.trim().split(/\s+/);
      var parts = [];
      for (var i = 0; i < ids.length; i++) {
        var ref = document.getElementById(ids[i]);
        if (ref) {
          parts.push((ref.textContent || "").trim());
        }
      }
      var joined = parts.join(" ").replace(/\s+/g, " ").trim();
      if (joined) {
        return joined;
      }
    }
    if (el.getAttribute) {
      var ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) {
        return ariaLabel.trim();
      }
    }
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "img" || tag === "area") {
      var alt = el.getAttribute("alt");
      if (alt) {
        return alt;
      }
    }
    if (tag === "input" || tag === "select" || tag === "textarea") {
      // Associated <label for=id> or wrapping <label>.
      if (el.id) {
        var label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label) {
          var lt = (label.textContent || "").trim();
          if (lt) return lt;
        }
      }
      var parent = el.parentElement;
      while (parent) {
        if (parent.tagName && parent.tagName.toLowerCase() === "label") {
          var pt = (parent.textContent || "").trim();
          if (pt) return pt;
          break;
        }
        parent = parent.parentElement;
      }
      if (tag === "input") {
        var t = (el.getAttribute("type") || "").toLowerCase();
        if (t === "submit" || t === "button" || t === "reset") {
          var v = el.value;
          if (v) return v;
        }
        var ph = el.getAttribute("placeholder");
        if (ph) return ph;
      }
    }
    if (el.hasAttribute && el.hasAttribute("title")) {
      var title = el.getAttribute("title");
      if (title && title.trim()) {
        return title.trim();
      }
    }
    // innerText (rendered text only) — textContent would leak <script> and
    // <style> source into the name (GitHub embeds JSON in script tags).
    var text = ((typeof el.innerText === "string" ? el.innerText : el.textContent) || "").replace(/\s+/g, " ").trim();
    return text;
  }

  // Tags whose subtree the spec treats as a name source only (i.e. their
  // children should still be walked, but the tag itself is not semantic).
  var TEXTUAL_TAGS = { p: true, span: true, div: true, strong: true, em: true, b: true, i: true, u: true, label: true, small: true, mark: true, abbr: true, code: true, pre: true, blockquote: true, q: true, cite: true, sub: true, sup: true, dl: true, dt: true, dd: true, fieldset: true, legend: true, caption: true, thead: true, tbody: true, tfoot: true, article: true, aside: true, address: true, figure: true, figcaption: true, details: true };

  // Non-rendered tags: never emit, never walk their subtrees.
  var A11Y_SKIP_TAGS = { head: true, script: true, style: true, noscript: true, template: true, link: true, meta: true, title: true };

  function doA11yTree() {
    var lines = [];
    var charCount = 0;
    var CHAR_CAP = 50000;

    function walk(node, depth) {
      if (charCount >= CHAR_CAP) {
        return;
      }
      if (!node || node.nodeType !== 1) {
        return;
      }
      if (A11Y_SKIP_TAGS[node.tagName.toLowerCase()]) {
        return;
      }
      if (isA11yHidden(node)) {
        return;
      }
      var role = roleOf(node);
      var name = accessibleName(node);
      // Only emit lines for nodes that are either semantic (have a role) or
      // carry an accessible name; pure structural wrappers are walked
      // silently. Name-bearing wrappers WITH element children are skipped
      // too: their name is just the concatenation of their children's text,
      // and emitting it duplicates the whole subtree's content per depth.
      var isLeaf = !node.children || node.children.length === 0;
      if (role || (name && isLeaf)) {
        var display = role ? role : "text";
        var quoted = name ? ' "' + name.replace(/\s+/g, " ").slice(0, 200) + '"' : "";
        var line = new Array(depth * 2 + 1).join(" ") + display + quoted;
        if (charCount + line.length + 1 > CHAR_CAP) {
          lines.push("…(truncated)");
          charCount = CHAR_CAP;
          return;
        }
        lines.push(line);
        charCount += line.length + 1;
      }
      var nextDepth = role ? depth + 1 : depth;
      var children = node.children;
      if (!children) {
        return;
      }
      for (var i = 0; i < children.length; i++) {
        walk(children[i], nextDepth);
        if (charCount >= CHAR_CAP) {
          return;
        }
      }
    }

    walk(document.documentElement, 0);
    return { ok: true, data: { tree: lines.join("\n") } };
  }

  // ---------------------------------------------------------------- message router

  browser.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.target !== "content") {
      return undefined;
    }
    var action = message.action;
    var params = message.params || {};

    var result;
    try {
      switch (action) {
        case "ping":           result = { ok: true, data: { pong: true } }; break;
        case "get_html":       result = doGetHtml(); break;
        case "get_console":    result = doGetConsole(); break;
        case "list_elements":  result = doListElements(); break;
        case "interact":       result = doInteract(params); break;
        case "press_keys":     result = doPressKeys(params); break;
        case "annotate_draw":  result = annotateDraw(); break;
        case "annotate_clear": result = annotateClear(); break;
        case "go_back":        result = doHistoryBack(); break;
        case "go_forward":     result = doHistoryForward(); break;
        case "click_xy":       result = doClickXY(params); break;
        case "scroll":         result = doScroll(params); break;
        case "iframe_rects":   result = doIframeRects(); break;
        case "get_a11y":       result = doA11yTree(); break;
        default:
          result = { ok: false, error: "unknown content action: " + action };
      }
    } catch (e) {
      result = { ok: false, error: "content handler threw: " + (e && e.message ? e.message : String(e)) };
    }

    // Synchronous response in all cases.
    try {
      sendResponse(result);
    } catch (e) {
      // If the message channel closed (sender navigated away), drop silently.
    }
    // Returning undefined (rather than true) is fine because sendResponse is
    // called synchronously above; no async work is pending.
    return undefined;
  });
})();
