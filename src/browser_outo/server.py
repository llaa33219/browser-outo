"""FastAPI server for browser-outo.

Holds the WebSocket endpoint that a browser extension connects to (outbound),
and an HTTP API that the local CLI talks to. The server is a thin relay:
it assigns each connected extension a small integer id, forwards JSON commands
to the right extension over its WebSocket, and matches the response back to the
pending HTTP caller by ``req_id``.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from .auth import write_token

logger = logging.getLogger("browser_outo.server")

VERSION = "0.3.0"

# Heartbeat: server pings every N seconds. Pongs are tolerated-but-optional.
PING_INTERVAL = 20.0


class ExtensionConn:
    """A single connected browser extension."""

    __slots__ = ("ext_id", "ws", "browser", "ext_version", "connected_at")

    def __init__(
        self,
        ext_id: int,
        ws: WebSocket,
        browser: str,
        ext_version: str,
        connected_at: str,
    ) -> None:
        self.ext_id = ext_id
        self.ws = ws
        self.browser = browser
        self.ext_version = ext_version
        self.connected_at = connected_at

    def info(self) -> dict[str, Any]:
        return {
            "ext_id": self.ext_id,
            "browser": self.browser,
            "ext_version": self.ext_version,
            "connected_at": self.connected_at,
        }


class ConnectionRegistry:
    """Owns all extension connections and the pending-response map.

    A single registry lives on ``app.state.registry``. All mutation happens in
    the same event loop, so no locking is required.
    """

    def __init__(self) -> None:
        # ext_id -> ExtensionConn
        self.conns: dict[int, ExtensionConn] = {}
        # id(websocket) -> ExtensionConn, used for O(1) cleanup on disconnect.
        self.ws_index: dict[int, ExtensionConn] = {}
        # req_id -> (future, ext_id). Futures are resolved by the WS reader or
        # by ``fail_pending_for`` on disconnect.
        self.pending: dict[str, tuple[asyncio.Future[dict[str, Any]], int]] = {}

    def assign_id(self) -> int:
        """Lowest unused positive integer. Freed ids are reused."""
        used = self.conns.keys()
        candidate = 1
        while candidate in used:
            candidate += 1
        return candidate

    def register(
        self, ws: WebSocket, browser: str, ext_version: str
    ) -> ExtensionConn:
        ext_id = self.assign_id()
        conn = ExtensionConn(
            ext_id=ext_id,
            ws=ws,
            browser=browser,
            ext_version=ext_version,
            connected_at=datetime.now(timezone.utc).isoformat(),
        )
        self.conns[ext_id] = conn
        self.ws_index[id(ws)] = conn
        return conn

    def remove_by_ws(self, ws: WebSocket) -> ExtensionConn | None:
        conn = self.ws_index.pop(id(ws), None)
        if conn is not None:
            self.conns.pop(conn.ext_id, None)
        return conn

    def get(self, ext_id: int) -> ExtensionConn | None:
        return self.conns.get(ext_id)

    def list_info(self) -> list[dict[str, Any]]:
        return [c.info() for c in self.conns.values()]

    def fail_pending_for(self, ext_id: int, error: str) -> None:
        """Resolve every still-open future owned by ``ext_id`` with an error."""
        doomed = [rid for rid, (_fut, owner) in self.pending.items() if owner == ext_id]
        for rid in doomed:
            entry = self.pending.pop(rid, None)
            if entry is None:
                continue
            fut = entry[0]
            if not fut.done():
                fut.set_result({"ok": False, "error": error})


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #


class CommandRequest(BaseModel):
    ext_id: int
    action: str
    params: dict[str, Any] = Field(default_factory=dict)
    timeout: float = 30.0


# --------------------------------------------------------------------------- #
# App factory
# --------------------------------------------------------------------------- #


def create_app(port: int) -> FastAPI:
    """Build a fresh FastAPI app with its own ConnectionRegistry.

    Writes a per-run auth token to ``token-<port>`` on construction. All
    ``/api/*`` routes require ``Authorization: Bearer <token>`` thereafter.
    ``GET /`` (health probe) stays unauthenticated — the browser extension
    uses it as a server-up check before the CLI has shared the token.
    """
    app = FastAPI(title="browser-outo", version=VERSION)

    auth_token, token_path = write_token(port)
    # Never log the token itself — only its on-disk location.
    print(f"auth token written to {token_path}", file=sys.stderr)

    registry = ConnectionRegistry()
    app.state.registry = registry
    app.state.auth_token = auth_token

    def _require_auth(authorization: str | None = Header(default=None)) -> None:
        """Reject any /api/* call without a matching bearer token.

        ``hmac.compare_digest`` is constant-time so the response latency
        does not leak how close a guessed token was.
        """
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="missing bearer token")
        provided = authorization[len("Bearer "):]
        if not hmac.compare_digest(provided, auth_token):
            raise HTTPException(status_code=401, detail="invalid token")

    # ---------------------------- HTTP routes ---------------------------- #

    @app.get("/")
    async def health() -> dict[str, Any]:
        return {"ok": True, "service": "browser-outo", "version": VERSION}

    @app.get("/api/extensions", dependencies=[Depends(_require_auth)])
    async def list_extensions() -> dict[str, Any]:
        return {"ok": True, "data": registry.list_info()}

    @app.post("/api/command", dependencies=[Depends(_require_auth)])
    async def post_command(req: CommandRequest) -> dict[str, Any]:
        conn = registry.get(req.ext_id)
        if conn is None:
            return {"ok": False, "error": "extension not connected"}

        req_id = str(uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        registry.pending[req_id] = (fut, req.ext_id)

        payload = {
            "type": "command",
            "req_id": req_id,
            "action": req.action,
            "params": req.params,
        }
        try:
            await conn.ws.send_json(payload)
        except Exception:
            # WS is closing / closed mid-send.
            registry.pending.pop(req_id, None)
            return {"ok": False, "error": "extension disconnected"}

        try:
            return await asyncio.wait_for(fut, timeout=req.timeout)
        except asyncio.TimeoutError:
            registry.pending.pop(req_id, None)
            return {"ok": False, "error": "timeout"}

    # ---------------------------- WebSocket ------------------------------ #

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        # Drive-by guard: browsers ALWAYS send an `Origin` header on every
        # WebSocket opened from a web page (RFC 6454). Browser-extension
        # service workers send chrome-extension:// / moz-extension:// origins
        # (allowed here). Local non-browser clients (the CLI, test harnesses)
        # send no Origin at all (also allowed). Any OTHER origin — meaning a
        # web page the user is browsing — is rejected with 1008 BEFORE
        # ws.accept(), so the WS handshake never completes and a malicious
        # site cannot register a fake extension or sniff the protocol.
        origin = ws.headers.get("origin")
        if origin is not None and not (
            origin.startswith("chrome-extension://")
            or origin.startswith("moz-extension://")
        ):
            await ws.close(code=1008)
            return

        await ws.accept()

        # Heartbeat: send {"type":"ping"} every PING_INTERVAL seconds. Missing
        # pongs are tolerated; we only stop on socket errors / cancellation.
        async def pinger() -> None:
            try:
                while True:
                    await asyncio.sleep(PING_INTERVAL)
                    await ws.send_json({"type": "ping"})
            except asyncio.CancelledError:
                raise
            except Exception:
                # Socket went away; let the main loop observe it.
                return

        ping_task = asyncio.create_task(pinger(), name="browser-outo-ping")
        conn: ExtensionConn | None = None

        try:
            # First frame MUST be {"type":"register", ...}.
            try:
                first_raw = await ws.receive_text()
                first = json.loads(first_raw)
            except WebSocketDisconnect:
                return
            except Exception:
                # Malformed first frame / binary — reject.
                logger.warning("ws: malformed register frame, closing")
                try:
                    await ws.close(code=1008)
                except Exception:
                    pass
                return

            if not isinstance(first, dict) or first.get("type") != "register":
                logger.warning("ws: first message was not register, closing")
                try:
                    await ws.close(code=1008)
                except Exception:
                    pass
                return

            browser = str(first.get("browser", "unknown"))
            ext_version = str(first.get("ext_version", "0.0.0"))
            conn = registry.register(ws, browser, ext_version)
            await ws.send_json({"type": "registered", "ext_id": conn.ext_id})

            while True:
                try:
                    raw = await ws.receive_text()
                except WebSocketDisconnect:
                    break
                except Exception:
                    logger.warning("ws: receive failure, dropping connection", exc_info=True)
                    break

                # Tolerate malformed JSON frames silently.
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue

                mtype = msg.get("type")

                if mtype == "response":
                    req_id = msg.get("req_id")
                    entry = registry.pending.pop(req_id, None) if isinstance(req_id, str) else None
                    if entry is not None:
                        fut = entry[0]
                        if not fut.done():
                            if msg.get("ok"):
                                fut.set_result({"ok": True, "data": msg.get("data", {})})
                            else:
                                fut.set_result(
                                    {"ok": False, "error": msg.get("error", "unknown error")}
                                )
                elif mtype == "pong":
                    # Heartbeat reply; intentionally ignored.
                    pass
                elif mtype == "ping":
                    # Some clients ping us; reply politely.
                    try:
                        await ws.send_json({"type": "pong"})
                    except Exception:
                        break
                else:
                    # Silently tolerate unknown/extra message types.
                    continue

        finally:
            # Cancel the heartbeat and drain it. NB: ``await ping_task`` re-raises
            # CancelledError on a cancelled task, and CancelledError is a
            # BaseException (not Exception) since 3.8 — so we must suppress both.
            ping_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await ping_task

            if conn is not None:
                registry.remove_by_ws(ws)
                registry.fail_pending_for(conn.ext_id, "extension disconnected")

            try:
                await ws.close()
            except Exception:
                pass

    return app
