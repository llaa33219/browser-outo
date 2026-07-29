/*
 * background.js — MV3 service worker.
 * Owns the outbound WebSocket to the local Python bridge, the registry
 * handshake, command dispatch, and the keepalive machinery.
 *
 * Layout:
 *   • WebSocket client (connect / register / heartbeat / backoff reconnect)
 *   • Command router (tab-API actions run here; DOM actions are forwarded to
 *     the content script via chrome.tabs.sendMessage)
 *   • MV3 keepalive (chrome.alarms every 30s + content-script cs_ping every
 *     20s + outbound ping every 20s — all three reset the SW idle timer)
 */

const WS_URL = "ws://127.0.0.1:11681/ws";
const HEALTH_URL = "http://127.0.0.1:11681/";
const EXT_VERSION = "0.3.0";
const PING_INTERVAL_MS = 20000;
const KEEPALIVE_ALARM = "outo-keepalive";
const RECONNECT_FLOOR_MS = 1000;
const RECONNECT_CAP_MS = 30000;

// --- Mutable SW state (rebuilt on every wake) ---
let ws = null;
let registeredExtId = null;
let backoffMs = RECONNECT_FLOOR_MS;
let pingTimer = null;
let reconnectTimer = null;

// ==================================================================
// WebSocket client
// ==================================================================
function nowConnectedState() {
  // Reset backoff; the next failure starts fresh.
  backoffMs = RECONNECT_FLOOR_MS;
}

// A failed WebSocket always prints a console error in Chrome (it cannot be
// suppressed), so we only open the socket after a silent fetch proves the
// server is up. A rejected fetch logs nothing when caught.
async function serverUp() {
  try {
    const r = await fetch(HEALTH_URL, { cache: "no-store" });
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function connectWS() {
  // Avoid duplicate sockets if already open or connecting.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // Only open the socket after a silent fetch proves the server is up.
  // Never probe the socket blindly: a failed WebSocket prints an
  // unsuppressible console error, and the user asked for silence.
  if (!(await serverUp())) {
    scheduleReconnect();
    return;
  }
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[outo] ws open, sending register");
    wsSend({ type: "register", browser: "chrome", ext_version: EXT_VERSION });
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    handleServerMessage(msg);
  };

  ws.onclose = () => {
    // Silent by design: the server may simply be off, and we retry forever.
    ws = null;
    stopPingTimer();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // Don't reconnect here; onclose will follow and handle backoff.
    // Intentionally no logging: a down server is normal, not an error.
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, RECONNECT_CAP_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWS();
  }, delay);
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

// ==================================================================
// Server message handler
// ==================================================================
function handleServerMessage(msg) {
  switch (msg.type) {
    case "registered":
      registeredExtId = msg.ext_id;
      console.log("[outo] registered ext_id=", registeredExtId);
      nowConnectedState();
      startPingTimer();
      break;

    case "ping":
      wsSend({ type: "pong" });
      break;

    case "command":
      handleCommand(msg);
      break;

    default:
      // Unknown server message — ignore (forward compatibility).
      break;
  }
}

// ==================================================================
// Heartbeat (outbound ping every 20s). The interval only persists while the
// SW is alive; the keepalive alarm + cs_ping message re-wake the SW, which
// re-runs this top-level module and restarts the interval.
// ==================================================================
function startPingTimer() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      wsSend({ type: "ping" });
    }
  }, PING_INTERVAL_MS);
}

function stopPingTimer() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

// ==================================================================
// Command dispatch
// ==================================================================
async function handleCommand(msg) {
  const reqId = msg.req_id;
  const action = msg.action;
  const params = msg.params || {};
  if (!reqId || !action) {
    wsSend({ type: "response", req_id: reqId || null, ok: false, error: "malformed command" });
    return;
  }
  try {
    const data = await dispatchAction(action, params);
    wsSend({ type: "response", req_id: reqId, ok: true, data: data || {} });
  } catch (e) {
    const errMsg = (e && e.message) ? e.message : String(e);
    console.warn("[outo] command failed", action, errMsg);
    wsSend({ type: "response", req_id: reqId, ok: false, error: errMsg });
  }
}

// Forward a DOM-scoped action to the content script of the given tab.
// frameId defaults to 0 (top frame). Never omit frameId: without it Chrome
// delivers the message to ALL frames and races the responses.
function sendToContent(tabId, action, params, frameId) {
  return new Promise((resolve, reject) => {
    try {
      const fid = frameId == null ? 0 : frameId;
      chrome.tabs.sendMessage(tabId, { target: "content", action: action, params: params || {} }, { frameId: fid }, (resp) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          reject(new Error("cannot access this tab (restricted page)"));
          return;
        }
        if (!resp) {
          reject(new Error("no response from content script"));
          return;
        }
        if (!resp.ok) {
          reject(new Error(resp.error || "content script error"));
          return;
        }
        resolve(resp.data);
      });
    } catch (e) {
      reject(new Error("cannot access this tab (restricted page)"));
    }
  });
}

// Enumerate elements across ALL frames of a tab and merge them into one
// index space. The index → (frameId, localIndex) mapping is persisted in
// storage.session so interact can route back to the right frame even after
// a service-worker restart. Element bboxes are converted from frame-local
// to absolute viewport coordinates using each frame's offset chain, which
// makes the bbox directly usable with click-xy (canvas widgets etc).
async function enumerateAllFrames(tabId, contentAction) {
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId: tabId });
  } catch (_) {
    frames = null;
  }
  const targets = frames && frames.length ? frames : [{ frameId: 0, url: "", parentFrameId: -1 }];

  // Cumulative viewport offset of each frame: offset(F) = offset(parent(F))
  // + the bounding rect of F's <iframe> element inside the parent document.
  const norm = (u) => String(u || "").split("#")[0];
  const offsets = { 0: { x: 0, y: 0 } };
  const rectCache = {};
  async function iframesOf(frameId) {
    if (!(frameId in rectCache)) {
      try {
        const r = await sendToContent(tabId, "iframe_rects", {}, frameId);
        rectCache[frameId] = (r && r.iframes) || [];
      } catch (_) {
        rectCache[frameId] = [];
      }
    }
    return rectCache[frameId];
  }
  async function offsetOf(frame) {
    if (frame.frameId === 0) return offsets[0];
    if (offsets[frame.frameId]) return offsets[frame.frameId];
    const parent = targets.find((t) => t.frameId === frame.parentFrameId);
    if (!parent) return { x: 0, y: 0 };
    const poff = await offsetOf(parent);
    const siblings = await iframesOf(parent.frameId);
    const mine = siblings.find((s) => norm(s.src) === norm(frame.url));
    const off = { x: poff.x + (mine ? mine.x : 0), y: poff.y + (mine ? mine.y : 0) };
    offsets[frame.frameId] = off;
    return off;
  }

  const results = await Promise.allSettled(
    targets.map((f) => sendToContent(tabId, contentAction, {}, f.frameId))
  );
  const merged = [];
  const map = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== "fulfilled") continue;
    const frameId = targets[i].frameId;
    const frameUrl = targets[i].url || "";
    const off = frameId === 0 ? { x: 0, y: 0 } : await offsetOf(targets[i]);
    const els = (r.value && r.value.elements) || [];
    for (const el of els) {
      map.push({ frameId: frameId, localIndex: el.index });
      const copy = Object.assign({}, el, {
        index: merged.length,
        frame: frameId,
        frame_url: frameId === 0 ? "" : frameUrl.slice(0, 160)
      });
      if (copy.bbox) {
        copy.bbox = {
          x: copy.bbox.x + off.x,
          y: copy.bbox.y + off.y,
          w: copy.bbox.w,
          h: copy.bbox.h
        };
      }
      merged.push(copy);
    }
  }
  try {
    await chrome.storage.session.set({ ["outo_elmap_" + tabId]: map });
  } catch (_) {}
  return merged;
}

// Walk down the iframe tree to find the deepest frame containing viewport
// point (x, y), returning frame-local coordinates. Frames are matched to
// their child frameIds via webNavigation's parentFrameId, so arbitrarily
// nested widgets (CAPTCHA challenge inside anchor iframe) resolve.
async function resolveFrameAtPoint(tabId, x, y) {
  const norm = (u) => String(u || "").split("#")[0];
  let frameId = 0;
  let offX = 0;
  let offY = 0;
  let frames = null;
  for (let depth = 0; depth < 5; depth++) {
    let rects;
    try {
      rects = await sendToContent(tabId, "iframe_rects", {}, frameId);
    } catch (_) {
      break;
    }
    const hit = ((rects && rects.iframes) || []).find(
      (r) => (x - offX) >= r.x && (x - offX) <= r.x + r.w && (y - offY) >= r.y && (y - offY) <= r.y + r.h
    );
    if (!hit || !hit.src) break;
    if (!frames) {
      try {
        frames = await chrome.webNavigation.getAllFrames({ tabId: tabId });
      } catch (_) {
        frames = null;
      }
    }
    const child = (frames || []).find(
      (fr) => fr.parentFrameId === frameId && norm(fr.url) === norm(hit.src)
    );
    if (!child) break;
    frameId = child.frameId;
    offX += hit.x;
    offY += hit.y;
  }
  return { frameId: frameId, x: x - offX, y: y - offY };
}

// Route a viewport-coordinate click into the deepest iframe containing the
// point, translating to frame-local coords. Falls back to the top frame.
async function routeClickXY(tabId, params) {
  const x = Number(params.x);
  const y = Number(params.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    try {
      const resolved = await resolveFrameAtPoint(tabId, x, y);
      if (resolved.frameId !== 0) {
        return sendToContent(tabId, "click_xy", { x: resolved.x, y: resolved.y }, resolved.frameId);
      }
    } catch (_) {}
  }
  return sendToContent(tabId, "click_xy", { x: params.x, y: params.y });
}

// Route an interact call to the frame that owns the given merged index.
async function routeInteract(tabId, params) {
  let map = null;
  try {
    const store = await chrome.storage.session.get("outo_elmap_" + tabId);
    map = store["outo_elmap_" + tabId] || null;
  } catch (_) {}
  const entry = map && map[params.index];
  if (!entry) {
    // No map (older flow) — top frame with the raw index.
    return sendToContent(tabId, "interact", params);
  }
  return sendToContent(
    tabId,
    "interact",
    Object.assign({}, params, { index: entry.localIndex }),
    entry.frameId
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function dispatchAction(action, params) {
  switch (action) {

    // -------- Tab-API actions (run in the service worker) --------
    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs.map((t) => ({
          tab_id: t.id,
          index: t.index,
          title: t.title || "",
          url: t.url || "",
          active: !!t.active,
          window_id: t.windowId
        }))
      };
    }

    case "open_tab": {
      if (!params.url) throw new Error("open_tab requires url");
      const tab = await chrome.tabs.create({
        url: params.url,
        active: params.active !== false
      });
      return { tab_id: tab.id };
    }

    case "close_tab": {
      await chrome.tabs.remove(params.tab_id);
      return { closed: true };
    }

    case "reload_tab": {
      await chrome.tabs.reload(params.tab_id);
      return { reloaded: true };
    }

    case "go_back": {
      // chrome.tabs.goBack is unreliable in practice (fails with a bogus
      // "Cannot find a next page in history" error even when history exists),
      // so navigate via the tab's own session history instead.
      await sendToContent(params.tab_id, "go_back", {});
      return { ok_history: true };
    }

    case "go_forward": {
      await sendToContent(params.tab_id, "go_forward", {});
      return { ok_history: true };
    }

    // -------- Screenshot --------
    case "screenshot": {
      const tabId = params.tab_id;
      const captured = await captureTab(tabId);
      let width = 0, height = 0;
      try {
        const vp = await sendToContent(tabId, "get_viewport", {});
        width = vp.width | 0;
        height = vp.height | 0;
      } catch (_) { /* leave zeros if content unreachable */ }
      return { png_base64: captured, width, height };
    }

    // -------- Annotate (split: draw → capture → remove, all frames) --------
    case "annotate": {
      const tabId = params.tab_id;
      // 1. every frame draws its own overlay + enumerates its elements
      const merged = await enumerateAllFrames(tabId, "annotate_draw");
      // 2. small delay so paint settles before capture
      await sleep(60);
      const captured = await captureTab(tabId);
      // 3. every frame removes its overlay
      let frames;
      try {
        frames = await chrome.webNavigation.getAllFrames({ tabId: tabId });
      } catch (_) {
        frames = null;
      }
      const targets = frames && frames.length ? frames : [{ frameId: 0 }];
      await Promise.allSettled(targets.map((f) => sendToContent(tabId, "annotate_remove", {}, f.frameId)));
      return { png_base64: captured, elements: merged };
    }

    // -------- get_console with graceful fallback --------
    case "get_console": {
      try {
        return await sendToContent(params.tab_id, "get_console", {});
      } catch (e) {
        return { entries: [], warning: "content script unreachable on this tab: " + e.message };
      }
    }

    // -------- Pure DOM actions (forwarded to content script) --------
    case "get_html":
      return sendToContent(params.tab_id, "get_html", {});
    case "list_elements":
      return { elements: await enumerateAllFrames(params.tab_id, "list_elements") };
    case "interact":
      return routeInteract(params.tab_id, params);
    case "press_keys":
      return sendToContent(params.tab_id, "press_keys", { keys: params.keys });
    case "click_xy":
      return routeClickXY(params.tab_id, params);
    case "scroll":
      return sendToContent(params.tab_id, "scroll", { dx: params.dx || 0, dy: params.dy || 0 });
    case "get_a11y":
      return sendToContent(params.tab_id, "get_a11y", {});

    default:
      throw new Error("unknown action: " + action);
  }
}

// Capture the currently-visible area of the tab's window.
async function captureTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  }
  // Allow focus + compositing to settle.
  await sleep(150);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  // captureVisibleTab returns a data: URL; strip the prefix per protocol.
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

// ==================================================================
// Keepalive alarm + content-script ping ack
// ==================================================================
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== KEEPALIVE_ALARM) return;
  // Both branches reset the SW idle timer: a WS send if connected, else a
  // reconnect attempt (which performs work on the SW).
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsSend({ type: "ping" });
  } else {
    connectWS();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Content script cs_ping — just acknowledge. Receiving this message is
  // enough to reset the SW idle timer; no further work required.
  if (msg && msg.type === "cs_ping") {
    try { sendResponse({ ok: true }); } catch (_) {}
    return false;
  }
  return false;
});

// Re-inject content scripts into tabs orphaned by an extension reload/update.
// Manifest content scripts only auto-inject on page load, so without this an
// extension restart leaves every existing tab unreachable until reloaded.
// The guards in content.js / pagehook.js make re-injection idempotent.
async function reinjectContentScripts() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (_) {
    return;
  }
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["pagehook.js"],
        world: "MAIN"
      });
    } catch (_) {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["content.js"]
      });
    } catch (_) {}
  }
}

// Ensure a connection on browser/profile startup and on install/update.
chrome.runtime.onStartup.addListener(() => { connectWS(); });
chrome.runtime.onInstalled.addListener(() => { connectWS(); reinjectContentScripts(); });

// ==================================================================
// SW startup — open the WS immediately. This top-level code runs on every
// service-worker wake, which is exactly what we want.
// ==================================================================
connectWS();
