/*
 * pagehook.js — injected into the page's MAIN world via <script src=...>.
 * Captures console.{log,info,warn,error,debug} and global error/unhandledrejection
 * events, then forwards each entry to the content script via window.postMessage.
 *
 * Everything is best-effort: any failure inside a hook must not break the page.
 * Idempotent: re-installs are no-ops once window.__outoPagehookInstalled is set.
 */
(function () {
  "use strict";
  if (window.__outoPagehookInstalled) {
    return;
  }
  window.__outoPagehookInstalled = true;

  // Snapshot the original console methods before any other extension wraps them.
  var nativeConsole = window.console;
  var originals = {
    log: nativeConsole.log,
    info: nativeConsole.info,
    warn: nativeConsole.warn,
    error: nativeConsole.error,
    debug: nativeConsole.debug
  };

  // Maximum length we will stringify a single argument to. Larger values get
  // truncated to keep the ring buffer useful rather than dominated by one entry.
  var MAX_STR_LEN = 4000;
  // Hard cap on number of sub-properties we will walk for nested objects.
  var MAX_DEPTH = 4;

  /**
   * Best-effort, side-effect-free serialization that survives circular
   * references, DOM nodes, functions, and throws-on-getter objects.
   * Returns a string.
   */
  function safeStringify(value) {
    var seen = [];
    function walk(v, depth) {
      if (depth > MAX_DEPTH) {
        return "...";
      }
      // primitives
      var t = typeof v;
      if (t === "string") {
        return v.length > MAX_STR_LEN ? v.slice(0, MAX_STR_LEN) + "…(" + v.length + ")" : v;
      }
      if (t === "number" || t === "boolean") {
        return String(v);
      }
      if (v === null) {
        return "null";
      }
      if (v === undefined) {
        return "undefined";
      }
      if (t === "function") {
        var name = v.name ? v.name : "<anonymous>";
        return "[Function " + name + "]";
      }
      if (t === "symbol") {
        return v.toString();
      }
      // Error objects: surface message + first stack line.
      if (v instanceof Error) {
        var msg = v.name + ": " + (v.message || "");
        if (v.stack) {
          var stackLines = String(v.stack).split("\n");
          if (stackLines.length > 1) {
            msg += "\n" + stackLines.slice(1, 4).join("\n");
          }
        }
        return msg;
      }
      // DOM nodes: produce a short selector-ish descriptor.
      if (v && v.nodeType && v.nodeName) {
        return describeNode(v);
      }
      // Arrays + plain objects.
      if (t === "object") {
        if (seen.indexOf(v) !== -1) {
          return "[Circular]";
        }
        seen.push(v);
        var out;
        try {
          if (Array.isArray(v)) {
            var items = [];
            for (var i = 0; i < v.length && i < 50; i++) {
              items.push(walk(v[i], depth + 1));
            }
            out = "[" + items.join(", ") + (v.length > 50 ? ", …(" + v.length + ")]" : "]");
          } else {
            var pairs = [];
            var count = 0;
            for (var key in v) {
              if (count++ > 50) {
                pairs.push("…");
                break;
              }
              var val;
              try {
                val = walk(v[key], depth + 1);
              } catch (e) {
                val = "[throw]";
              }
              pairs.push(key + ": " + val);
            }
            out = "{" + pairs.join(", ") + "}";
          }
        } catch (e) {
          out = "[unserializable]";
        }
        seen.pop();
        return out;
      }
      return String(v);
    }
    return walk(value, 0);
  }

  function describeNode(node) {
    try {
      var tag = (node.tagName || "?").toLowerCase();
      var id = node.id ? "#" + node.id : "";
      var cls = node.className && typeof node.className === "string" && node.className.trim()
        ? "." + node.className.trim().split(/\s+/).slice(0, 3).join(".")
        : "";
      return "<" + tag + id + cls + ">";
    } catch (e) {
      return "<" + (node && node.nodeName ? node.nodeName.toLowerCase() : "node") + ">";
    }
  }

  /**
   * Join a console.* argument list into a single text line, the same way
   * the browser devtools would render a single console message.
   */
  function formatArgs(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      parts.push(safeStringify(args[i]));
    }
    return parts.join(" ");
  }

  function emit(level, args) {
    var text = formatArgs(args);
    try {
      window.postMessage({ __outo: true, level: level, text: text, timestamp: Date.now() }, "*");
    } catch (e) {
      // postMessage itself should never fail for structured-cloneable data,
      // but we must not let the page's own console.* throw.
    }
  }

  function wrapMethod(name) {
    var original = originals[name];
    nativeConsole[name] = function outoWrapped() {
      var args = Array.prototype.slice.call(arguments);
      emit(name, args);
      // Forward to the real console so the user's devtools still work.
      try {
        original.apply(nativeConsole, args);
      } catch (e) {
        // Some pages re-wrap console; ignore.
      }
    };
  }

  ["log", "info", "warn", "error", "debug"].forEach(wrapMethod);

  // Capture uncaught errors + unhandled promise rejections the same way.
  window.addEventListener("error", function (event) {
    var message = event.message || "Error";
    if (event.filename) {
      message += "  (" + event.filename + ":" + (event.lineno || 0) + ":" + (event.colno || 0) + ")";
    }
    if (event.error && event.error.stack) {
      message += "\n" + String(event.error.stack).split("\n").slice(0, 4).join("\n");
    }
    emit("error", [message]);
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    var payload;
    if (reason instanceof Error) {
      payload = reason.name + ": " + (reason.message || "") +
        (reason.stack ? "\n" + String(reason.stack).split("\n").slice(0, 4).join("\n") : "");
    } else {
      payload = safeStringify(reason);
    }
    emit("error", ["Unhandled promise rejection: " + payload]);
  });
})();
