/*
 * pagehook.js — runs in the page's MAIN world (registered in manifest.json
 * as a "world": "MAIN" content script; content.js also injects it via a
 * <script src> tag as a fallback, and the install guard below dedupes).
 * Captures console.* and global error/rejection events, forwarding each entry
 * to the content script (isolated world) via window.postMessage with an
 * __outo marker. Runs before page scripts so we wrap the originals first.
 */
(() => {
  if (window.__outoPagehookInstalled) return;
  window.__outoPagehookInstalled = true;

  const LEVELS = ["log", "info", "warn", "error", "debug"];
  const orig = Object.create(null);

  // --- Safe serialization with circular & non-JSON guard ---
  function safeStringify(value) {
    const seen = new WeakSet();
    try {
      return JSON.stringify(value, (k, v) => {
        if (typeof v === "function") return "[Function " + (v.name || "anonymous") + "]";
        if (typeof v === "symbol") return v.toString();
        if (typeof v === "bigint") return v.toString() + "n";
        if (v === undefined) return undefined; // dropped by JSON
        if (v !== null && typeof v === "object") {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
          // Try to surface DOM nodes readably.
          if (typeof v.tagName === "string") {
            return `<${v.tagName.toLowerCase()}>`;
          }
          if (v instanceof Error) return v.name + ": " + v.message;
        }
        return v;
      });
    } catch (e) {
      try { return String(value); } catch (_) { return "[Unserializable]"; }
    }
  }

  function serializeArgs(args) {
    if (!args || args.length === 0) return "";
    return Array.prototype.map.call(args, (a) => {
      if (a === null) return "null";
      if (a === undefined) return "undefined";
      if (typeof a === "string") return a;
      if (typeof a === "number" || typeof a === "boolean" || typeof a === "bigint") return String(a);
      return safeStringify(a);
    }).join(" ");
  }

  // Per-page-load nonce handshake with content.js (isolated world). See the
  // matching comment in content.js for the security model — this only stops
  // accidental / low-effort forgery, not a determined page script.
  let outoNonce = null;
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__outo !== true) return;
    if (d.kind === "init" && typeof d.nonce === "string") {
      outoNonce = d.nonce;
    }
  });

  function post(level, text) {
    if (outoNonce === null) return; // no nonce yet → content would drop anyway
    try {
      window.postMessage(
        {
          __outo: true, kind: "console", level: level, text: text,
          ts: Date.now() / 1000, nonce: outoNonce
        },
        "*"
      );
    } catch (_) { /* never let logging itself throw */ }
  }

  // --- Wrap console methods, preserving original behaviour ---
  for (const lvl of LEVELS) {
    const target = console[lvl];
    orig[lvl] = typeof target === "function" ? target.bind(console) : console.log.bind(console);
    console[lvl] = function outoWrapped(...args) {
      try { post(lvl, serializeArgs(args)); } catch (_) {}
      return orig[lvl].apply(console, args);
    };
  }

  // --- Global error / unhandled rejection listeners ---
  window.addEventListener("error", (e) => {
    let text = String(e.message || "(unknown error)");
    if (e.filename) text += ` @ ${e.filename}:${e.lineno || 0}:${e.colno || 0}`;
    post("error", text);
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e && e.reason;
    let text = "Unhandled promise rejection: ";
    text += (reason instanceof Error)
      ? (reason.name + ": " + reason.message)
      : safeStringify(reason);
    post("error", text);
  });
})();
