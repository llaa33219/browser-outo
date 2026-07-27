/*
 * background.js — persistent MV2 background page for browser-outo (Firefox).
 *
 * Owns:
 *   - A WebSocket client that connects OUTBOUND to ws://127.0.0.1:11681/ws.
 *   - Connection lifecycle: immediate connect at script load, exponential
 *     backoff reconnect (1s → 30s cap) on close/error.
 *   - Heartbeat: send {"type":"ping"} every 20s, reply {"type":"pong"} to
 *     any server ping.
 *   - Command dispatch: server {type:"command",req_id,action,params} →
 *     {type:"response",req_id,ok,data|error}.
 *
 * Tab-API actions (list_tabs, open_tab, close_tab, reload_tab, screenshot,
 * annotate) run here. DOM actions (get_html, get_console, list_elements,
 * interact, press_keys, get_a11y, go_back, go_forward) are forwarded to the
 * matching content.js via browser.tabs.sendMessage.
 *
 * The browser.* promise-based API is used throughout (Firefox native).
 */

(function () {
  "use strict";

  var WS_URL = "ws://127.0.0.1:11681/ws";
  var HEALTH_URL = "http://127.0.0.1:11681/";
  var EXT_VERSION = "0.1.0";
  var HEARTBEAT_MS = 20000;
  var BACKOFF_MIN_MS = 1000;
  var BACKOFF_MAX_MS = 30000;
  // Wait this long after activating a tab/window before captureVisibleTab so
  // the compositor has flushed the new pixels.
  var CAPTURE_SETTLE_MS = 150;

  var socket = null;
  var heartbeatTimer = null;
  var backoffMs = BACKOFF_MIN_MS;
  var reconnectTimer = null;
  var registeredExtId = null;

  // ---------------------------------------------------------------- send helpers

  function safeSend(obj) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      socket.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      // Drop silently; onclose will trigger reconnect.
      return false;
    }
  }

  function sendResponse(reqId, ok, payload) {
    var frame = { type: "response", req_id: reqId, ok: !!ok };
    if (ok) {
      frame.data = payload || {};
    } else {
      frame.error = typeof payload === "string" ? payload : String(payload);
    }
    safeSend(frame);
  }

  function sendOk(reqId, data) {
    sendResponse(reqId, true, data);
  }

  function sendError(reqId, message) {
    sendResponse(reqId, false, message);
  }

  // ---------------------------------------------------------------- ws lifecycle

  function clearHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) {
      return;
    }
    var delay = backoffMs;
    backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // A failed WebSocket always prints a console error in the browser (it
  // cannot be suppressed), so we only open the socket after a silent fetch
  // proves the server is up. A rejected fetch logs nothing when caught.
  function serverUp() {
    return fetch(HEALTH_URL, { cache: "no-store" })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }

  function connect() {
    // Only open the socket after a silent fetch proves the server is up.
    // Never probe the socket blindly: a failed WebSocket prints an
    // unsuppressible console error, and the user asked for silence.
    serverUp().then(function (up) {
      if (up) {
        openSocket();
      } else {
        scheduleReconnect();
      }
    });
  }

  function openSocket() {
    try {
      socket = new WebSocket(WS_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    socket.onopen = function () {
      // Reset backoff on successful connection.
      backoffMs = BACKOFF_MIN_MS;
      // First frame per spec.
      safeSend({ type: "register", browser: "firefox", ext_version: EXT_VERSION });
      // Start heartbeat.
      clearHeartbeat();
      heartbeatTimer = setInterval(function () {
        safeSend({ type: "ping" });
      }, HEARTBEAT_MS);
    };

    socket.onmessage = function (event) {
      var frame;
      try {
        frame = JSON.parse(event.data);
      } catch (e) {
        // Ignore malformed frames.
        return;
      }
      if (!frame || typeof frame !== "object") {
        return;
      }
      handleServerFrame(frame);
    };

    socket.onerror = function () {
      // The follow-up onclose will handle reconnect. Nothing to do here that
      // wouldn't race with onclose.
    };

    socket.onclose = function () {
      clearHeartbeat();
      socket = null;
      scheduleReconnect();
    };
  }

  // ---------------------------------------------------------------- server frame router

  function handleServerFrame(frame) {
    switch (frame.type) {
      case "registered":
        registeredExtId = frame.ext_id;
        break;
      case "ping":
        safeSend({ type: "pong" });
        break;
      case "command":
        // Always dispatch asynchronously so any thrown error is contained.
        dispatchCommand(frame).catch(function (err) {
          sendError(frame.req_id, "unexpected error: " + (err && err.message ? err.message : String(err)));
        });
        break;
      default:
        // Unknown frame types are ignored silently to stay forward-compatible.
        break;
    }
  }

  // ---------------------------------------------------------------- command dispatch

  async function dispatchCommand(frame) {
    var reqId = frame.req_id;
    var action = frame.action;
    var params = frame.params || {};

    try {
      var handler = ACTION_HANDLERS[action];
      if (!handler) {
        sendError(reqId, "unknown action: " + action);
        return;
      }
      var data = await handler(params);
      sendOk(reqId, data);
    } catch (e) {
      sendError(reqId, (e && e.message ? e.message : String(e)));
    }
  }

  // ---------------------------------------------------------------- content bridge

  /**
   * Send a message to the content script of `tabId`. Translates the promise
   * rejection ("Receiving end does not exist") into a user-visible error
   * message instead of an opaque rejection.
   */
  // frameId defaults to 0 (top frame). Never omit frameId: without it the
  // message goes to ALL frames and the responses race.
  function sendToContent(tabId, action, params, frameId) {
    var fid = frameId == null ? 0 : frameId;
    return browser.tabs.sendMessage(tabId, { target: "content", action: action, params: params || {} }, { frameId: fid })
      .then(function (resp) {
        if (resp && typeof resp === "object" && resp.ok) {
          return resp.data;
        }
        var msg = resp && resp.error ? resp.error : "content script returned no data";
        var err = new Error(msg);
        err.outoSoftFail = true; // already a friendly message; don't rewrap
        throw err;
      }, function (rej) {
        var m = (rej && rej.message) ? rej.message : String(rej);
        var friendly;
        if (/Receiving end does not exist|Could not establish connection|missing host permission/i.test(m)) {
          friendly = "cannot access this tab (restricted page)";
        } else {
          friendly = "content communication failed: " + m;
        }
        var err = new Error(friendly);
        err.outoSoftFail = true;
        throw err;
      });
  }

  // Element index → (frameId, localIndex) maps per tab. Kept in memory: the
  // MV2 background page is persistent, so there is no worker-death to fear.
  var elementMaps = {};

  // Enumerate elements across ALL frames of a tab and merge them into one
  // index space; remember which frame owns each merged index for interact.
  // Element bboxes are converted from frame-local to absolute viewport
  // coordinates using each frame's offset chain (usable with click-xy).
  async function enumerateAllFrames(tabId, contentAction) {
    var frames;
    try {
      frames = await browser.webNavigation.getAllFrames({ tabId: tabId });
    } catch (e) {
      frames = null;
    }
    var targets = frames && frames.length ? frames : [{ frameId: 0, url: "", parentFrameId: -1 }];

    var norm = function (u) { return String(u || "").split("#")[0]; };
    var offsets = { 0: { x: 0, y: 0 } };
    var rectCache = {};
    async function iframesOf(frameId) {
      if (!(frameId in rectCache)) {
        try {
          var r = await sendToContent(tabId, "iframe_rects", {}, frameId);
          rectCache[frameId] = (r && r.iframes) || [];
        } catch (e) {
          rectCache[frameId] = [];
        }
      }
      return rectCache[frameId];
    }
    async function offsetOf(frame) {
      if (frame.frameId === 0) return offsets[0];
      if (offsets[frame.frameId]) return offsets[frame.frameId];
      var parent = targets.find(function (t) { return t.frameId === frame.parentFrameId; });
      if (!parent) return { x: 0, y: 0 };
      var poff = await offsetOf(parent);
      var siblings = await iframesOf(parent.frameId);
      var mine = siblings.find(function (s) { return norm(s.src) === norm(frame.url); });
      var off = { x: poff.x + (mine ? mine.x : 0), y: poff.y + (mine ? mine.y : 0) };
      offsets[frame.frameId] = off;
      return off;
    }

    var settled = await Promise.allSettled(
      targets.map(function (f) { return sendToContent(tabId, contentAction, {}, f.frameId); })
    );
    var merged = [];
    var map = [];
    for (var i = 0; i < settled.length; i++) {
      var r = settled[i];
      if (r.status !== "fulfilled") continue;
      var frameId = targets[i].frameId;
      var frameUrl = targets[i].url || "";
      var off = frameId === 0 ? { x: 0, y: 0 } : await offsetOf(targets[i]);
      var els = (r.value && r.value.elements) || [];
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        map.push({ frameId: frameId, localIndex: el.index });
        var copy = Object.assign({}, el);
        copy.index = merged.length;
        copy.frame = frameId;
        copy.frame_url = frameId === 0 ? "" : frameUrl.slice(0, 160);
        if (copy.bbox) {
          copy.bbox = { x: copy.bbox.x + off.x, y: copy.bbox.y + off.y, w: copy.bbox.w, h: copy.bbox.h };
        }
        merged.push(copy);
      }
    }
    elementMaps[tabId] = map;
    return merged;
  }

  function routeInteract(tabId, params) {
    var map = elementMaps[tabId];
    var entry = map && map[params.index];
    if (!entry) {
      return sendToContent(tabId, "interact", params);
    }
    return sendToContent(
      tabId,
      "interact",
      Object.assign({}, params, { index: entry.localIndex }),
      entry.frameId
    );
  }

  // Walk down the iframe tree to find the deepest frame containing viewport
  // point (x, y), returning frame-local coordinates. Frames are matched to
  // their child frameIds via webNavigation's parentFrameId, so arbitrarily
  // nested widgets (CAPTCHA challenge inside anchor iframe) resolve.
  async function resolveFrameAtPoint(tabId, x, y) {
    var norm = function (u) { return String(u || "").split("#")[0]; };
    var frameId = 0;
    var offX = 0;
    var offY = 0;
    var frames = null;
    for (var depth = 0; depth < 5; depth++) {
      var rects;
      try {
        rects = await sendToContent(tabId, "iframe_rects", {}, frameId);
      } catch (e) {
        break;
      }
      var hit = ((rects && rects.iframes) || []).find(function (r) {
        return (x - offX) >= r.x && (x - offX) <= r.x + r.w && (y - offY) >= r.y && (y - offY) <= r.y + r.h;
      });
      if (!hit || !hit.src) break;
      if (!frames) {
        try {
          frames = await browser.webNavigation.getAllFrames({ tabId: tabId });
        } catch (e2) {
          frames = null;
        }
      }
      var child = (frames || []).find(function (fr) {
        return fr.parentFrameId === frameId && norm(fr.url) === norm(hit.src);
      });
      if (!child) break;
      frameId = child.frameId;
      offX += hit.x;
      offY += hit.y;
    }
    return { frameId: frameId, x: x - offX, y: y - offY };
  }

  // Route a viewport-coordinate click into the deepest iframe containing
  // the point, translating to frame-local coords. Falls back to top frame.
  async function routeClickXY(tabId, params) {
    var x = Number(params.x);
    var y = Number(params.y);
    if (isFinite(x) && isFinite(y)) {
      try {
        var resolved = await resolveFrameAtPoint(tabId, x, y);
        if (resolved.frameId !== 0) {
          return sendToContent(tabId, "click_xy", { x: resolved.x, y: resolved.y }, resolved.frameId);
        }
      } catch (e) {}
    }
    return sendToContent(tabId, "click_xy", params);
  }

  // ---------------------------------------------------------------- tab-API actions

  var ACTION_HANDLERS = {};

  ACTION_HANDLERS.list_tabs = async function () {
    var tabs = await browser.tabs.query({});
    var out = tabs.map(function (t) {
      return {
        tab_id: t.id,
        index: t.index,
        title: t.title || "",
        url: t.url || "",
        active: !!t.active,
        window_id: t.windowId
      };
    });
    return { tabs: out };
  };

  ACTION_HANDLERS.open_tab = async function (params) {
    var url = params && params.url;
    if (!url) {
      throw new Error("open_tab requires 'url'");
    }
    var active = params.active !== undefined ? !!params.active : true;
    var tab = await browser.tabs.create({ url: url, active: active });
    return { tab_id: tab.id };
  };

  ACTION_HANDLERS.close_tab = async function (params) {
    var tabId = requireTabId(params);
    await browser.tabs.remove(tabId);
    return { closed: true };
  };

  ACTION_HANDLERS.reload_tab = async function (params) {
    var tabId = requireTabId(params);
    await browser.tabs.reload(tabId, { bypassCache: false });
    return { reloaded: true };
  };

  // ---------------------------------------------------------------- DOM-forwarded actions

  ACTION_HANDLERS.get_html = function (params) {
    return sendToContent(requireTabId(params), "get_html");
  };
  ACTION_HANDLERS.get_console = function (params) {
    return sendToContent(requireTabId(params), "get_console");
  };
  ACTION_HANDLERS.list_elements = async function (params) {
    return { elements: await enumerateAllFrames(requireTabId(params), "list_elements") };
  };
  ACTION_HANDLERS.interact = function (params) {
    return routeInteract(requireTabId(params), params);
  };
  ACTION_HANDLERS.press_keys = function (params) {
    return sendToContent(requireTabId(params), "press_keys", params);
  };
  ACTION_HANDLERS.click_xy = function (params) {
    return routeClickXY(requireTabId(params), params);
  };
  ACTION_HANDLERS.scroll = function (params) {
    return sendToContent(requireTabId(params), "scroll", params);
  };
  ACTION_HANDLERS.get_a11y = function (params) {
    return sendToContent(requireTabId(params), "get_a11y");
  };
  ACTION_HANDLERS.go_back = function (params) {
    return sendToContent(requireTabId(params), "go_back");
  };
  ACTION_HANDLERS.go_forward = function (params) {
    return sendToContent(requireTabId(params), "go_forward");
  };

  // ---------------------------------------------------------------- screenshot

  function requireTabId(params) {
    var id = params && params.tab_id;
    if (typeof id !== "number" || !isFinite(id)) {
      throw new Error("action requires numeric 'tab_id'");
    }
    return id;
  }

  function decodePngSize(base64) {
    // PNG layout: 8-byte signature, then IHDR chunk. IHDR appears first by spec.
    //   [0..7]   signature
    //   [8..11]  IHDR length (BE u32) = 13
    //   [12..15] "IHDR"
    //   [16..19] width  (BE u32)
    //   [20..23] height (BE u32)
    try {
      var slice = base64.slice(0, 32);
      var bin = atob(slice);
      if (bin.length < 24) {
        return null;
      }
      var w = (bin.charCodeAt(16) << 24) | (bin.charCodeAt(17) << 16) |
              (bin.charCodeAt(18) << 8) | bin.charCodeAt(19);
      var h = (bin.charCodeAt(20) << 24) | (bin.charCodeAt(21) << 16) |
              (bin.charCodeAt(22) << 8) | bin.charCodeAt(23);
      // Interpret as unsigned.
      return { width: w >>> 0, height: h >>> 0 };
    } catch (e) {
      return null;
    }
  }

  function stripDataUrlPrefix(dataUrl) {
    var idx = dataUrl.indexOf(",");
    if (idx !== -1 && dataUrl.indexOf("base64") !== -1) {
      return dataUrl.slice(idx + 1);
    }
    return dataUrl;
  }

  async function activateTabAndWindow(tabId) {
    var tab = await browser.tabs.get(tabId);
    if (!tab) {
      throw new Error("tab not found");
    }
    // Make the tab active in its window, then focus the window so the
    // compositor actually rasterizes its pixels for captureVisibleTab.
    if (!tab.active) {
      await browser.tabs.update(tabId, { active: true });
    }
    try {
      await browser.windows.update(tab.windowId, { focused: true });
    } catch (e) {
      // Some environments (e.g. headless) reject window focus; ignore.
    }
    return tab.windowId;
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  ACTION_HANDLERS.screenshot = async function (params) {
    var tabId = requireTabId(params);
    var windowId = await activateTabAndWindow(tabId);
    await delay(CAPTURE_SETTLE_MS);
    var dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: "png" });
    var b64 = stripDataUrlPrefix(dataUrl);
    var size = decodePngSize(b64) || { width: 0, height: 0 };
    return { png_base64: b64, width: size.width, height: size.height };
  };

  // ---------------------------------------------------------------- annotate

  ACTION_HANDLERS.annotate = async function (params) {
    var tabId = requireTabId(params);
    // 1. Every frame draws its own overlay and reports its elements.
    var merged = await enumerateAllFrames(tabId, "annotate_draw");
    // 2. Capture the visible tab (the overlay is in-document so it appears
    //    in the raster). On any failure here, still try to clean up.
    var windowId;
    try {
      windowId = await activateTabAndWindow(tabId);
      await delay(CAPTURE_SETTLE_MS);
      var dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: "png" });
      var b64 = stripDataUrlPrefix(dataUrl);
      var size = decodePngSize(b64) || { width: 0, height: 0 };
      return {
        png_base64: b64,
        width: size.width,
        height: size.height,
        elements: merged
      };
    } finally {
      // 3. Always remove the overlay in every frame, even if capture threw.
      var frames;
      try {
        frames = await browser.webNavigation.getAllFrames({ tabId: tabId });
      } catch (e) {
        frames = null;
      }
      var targets = frames && frames.length ? frames : [{ frameId: 0 }];
      await Promise.allSettled(targets.map(function (f) {
        return sendToContent(tabId, "annotate_clear", {}, f.frameId);
      }));
    }
  };

  // ---------------------------------------------------------------- boot

  // Re-inject content scripts into tabs orphaned by an extension reload.
  // Manifest content scripts only auto-inject on page load; the guards in
  // content.js / pagehook.js make re-injection idempotent.
  function reinjectContentScripts() {
    browser.tabs.query({}).then(function (tabs) {
      tabs.forEach(function (tab) {
        if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) return;
        // MV2 executeScript only reaches the isolated world; content.js
        // re-injects pagehook.js into the MAIN world itself on init.
        browser.tabs.executeScript(tab.id, { file: "content.js", allFrames: true }).catch(function () {});
      });
    }).catch(function () {});
  }

  browser.runtime.onInstalled.addListener(function () { reinjectContentScripts(); });
  browser.runtime.onStartup.addListener(function () { reinjectContentScripts(); });

  connect();
})();
