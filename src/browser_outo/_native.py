"""CLI-side native transport: sync socket client + install-native plumbing.

The CLI is otherwise synchronous (``httpx.Client``); native socket access stays
synchronous here to match. When no native sockets exist, callers fall back to
the existing HTTP+Bearer path unchanged.
"""

from __future__ import annotations

import json
import os
import select
import socket
import stat
import struct
import sys
import time
from pathlib import Path
from uuid import uuid4

from .auth import token_dir
from .native_host import FIREFOX_ADDON_ID, PINNED_CHROME_ID

# Margin over the per-command timeout before the CLI itself gives up waiting
# for a frame from the host (the host enforces the real timeout).
_RECV_MARGIN = 5.0
# Liveness probe budget for ``extensions`` listing.
_PROBE_TIMEOUT = 2.0


class TransportLost(Exception):
    """Socket broke mid-command — outcome unknown, side effects may have run."""


# --------------------------------------------------------------------------- #
# Framing (synchronous)
# --------------------------------------------------------------------------- #


def _send_frame(sock: socket.socket, msg: dict) -> None:
    payload = json.dumps(msg).encode("utf-8")
    sock.sendall(struct.pack("<I", len(payload)) + payload)


def _recv_exact(sock: socket.socket, n: int, deadline: float) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        ready, _, _ = select.select([sock], [], [], remaining)
        if not ready:
            raise TimeoutError()
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise TransportLost()
        buf.extend(chunk)
    return bytes(buf)


def _recv_frame(sock: socket.socket, deadline: float) -> dict:
    raw_len = _recv_exact(sock, 4, deadline)
    (length,) = struct.unpack("<I", raw_len)
    payload = _recv_exact(sock, length, deadline)
    return json.loads(payload.decode("utf-8"))


# --------------------------------------------------------------------------- #
# Socket / token discovery
# --------------------------------------------------------------------------- #


def native_socket_dir() -> Path:
    return token_dir() / "native"


def native_sockets() -> list[Path]:
    """Sorted list of ``<browser>.sock`` paths currently on disk."""
    d = native_socket_dir()
    if not d.is_dir():
        return []
    return sorted(d.glob("*.sock"))


def resolve_native_browser(ext_arg: object) -> str | None:
    """Resolve a CLI ext argument to a browser name with a live socket file.

    Accepts the literal browser name (``chrome``/``firefox``) or a 1-based
    index into the sorted socket list. Returns ``None`` if native sockets
    exist but ``ext_arg`` matches none (caller treats that as a hard error,
    not a silent HTTP fallback).
    """
    sockets = native_sockets()
    if not sockets:
        return None
    browsers = [p.stem for p in sockets]
    if isinstance(ext_arg, str) and ext_arg in browsers:
        return ext_arg
    if isinstance(ext_arg, int):
        if 1 <= ext_arg <= len(browsers):
            return browsers[ext_arg - 1]
        return None
    if isinstance(ext_arg, str) and ext_arg.isdigit():
        idx = int(ext_arg)
        if 1 <= idx <= len(browsers):
            return browsers[idx - 1]
    return None


def read_native_token(browser: str) -> str | None:
    try:
        return (token_dir() / f"native-token-{browser}").read_text("utf-8").strip()
    except OSError:
        return None


# --------------------------------------------------------------------------- #
# Transport operations
# --------------------------------------------------------------------------- #


def native_command(
    ext_arg: object, action: str, params: dict, timeout: float
) -> dict | None:
    """Send one command frame to the native host and await its response.

    Returns the response envelope (``{type, req_id, ok, data|error}``), or
    ``None`` if no native sockets exist at all (caller falls back to HTTP).
    Raises :class:`TransportLost` if the socket breaks before the response
    arrives — the caller MUST surface that as "outcome unknown".
    """
    browser = resolve_native_browser(ext_arg)
    if browser is None:
        if native_sockets():
            raise ValueError(
                f"no native socket matches {ext_arg!r}; available: "
                f"{[p.stem for p in native_sockets()]}"
            )
        return None
    token = read_native_token(browser)
    if token is None:
        raise FileNotFoundError(f"native token for {browser} not found")
    rid = str(uuid4())
    sock_path = native_socket_dir() / f"{browser}.sock"
    deadline = time.monotonic() + timeout + _RECV_MARGIN
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(_PROBE_TIMEOUT)
        s.connect(str(sock_path))
        _send_frame(s, {"type": "auth", "token": token})
        _send_frame(
            s,
            {
                "type": "command",
                "req_id": rid,
                "action": action,
                "params": params,
                "timeout": timeout,
            },
        )
        while True:
            msg = _recv_frame(s, deadline)
            if msg.get("type") == "response":
                return msg
            # tolerate interleaved pong/unknown frames


def native_alive(browser: str) -> bool:
    """Quick connect+auth+ping liveness probe used by ``extensions``."""
    token = read_native_token(browser)
    if token is None:
        return False
    sock_path = native_socket_dir() / f"{browser}.sock"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(_PROBE_TIMEOUT)
            s.connect(str(sock_path))
            _send_frame(s, {"type": "auth", "token": token})
            _send_frame(s, {"type": "ping"})
            deadline = time.monotonic() + _PROBE_TIMEOUT
            return _recv_frame(s, deadline).get("type") == "pong"
    except (OSError, TransportLost, TimeoutError):
        return False


# --------------------------------------------------------------------------- #
# install-native
# --------------------------------------------------------------------------- #


def _wrapper_path() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "browser-outo" / "native-host"
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) / "browser-outo" if xdg else Path.home() / ".local" / "share" / "browser-outo"
    return base / "native-host"


def _chrome_manifest_dirs() -> list[Path]:
    home = Path.home()
    if sys.platform == "darwin":
        return [
            home / "Library" / "Application Support" / "Google" / "Chrome" / "NativeMessagingHosts",
            home / "Library" / "Application Support" / "Chromium" / "NativeMessagingHosts",
        ]
    return [
        home / ".config" / "google-chrome" / "NativeMessagingHosts",
        home / ".config" / "chromium" / "NativeMessagingHosts",
    ]


def _firefox_manifest_dirs() -> list[Path]:
    home = Path.home()
    if sys.platform == "darwin":
        return [home / "Library" / "Application Support" / "Mozilla" / "NativeMessagingHosts"]
    return [
        home / ".mozilla" / "native-messaging-hosts",
        home / ".config" / "mozilla" / "native-messaging-hosts",
    ]


def _normalize_origin(cid: str) -> str:
    """Accept bare id, ``chrome-extension://<id>``, with/without trailing slash."""
    if cid.startswith("chrome-extension://"):
        return cid if cid.endswith("/") else cid + "/"
    return f"chrome-extension://{cid}/"


def _make_executable(path: Path) -> None:
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def install_native(chrome_ids: tuple[str, ...]) -> list[str]:
    """Write the wrapper script + all Chrome/Chromium + Firefox manifests.

    Idempotent: every file is overwritten. Returns the list of written paths
    (manifests and wrapper) in write order. On Windows the caller prints an
    unsupported message and returns an empty list — call sites gate this.
    """
    if sys.platform == "win32":
        return []

    wrapper = _wrapper_path()
    wrapper.parent.mkdir(parents=True, exist_ok=True)
    wrapper.write_text(
        f'#!/bin/sh\nexec "{sys.executable}" -u -m browser_outo.native_host "$@"\n',
        encoding="utf-8",
    )
    _make_executable(wrapper)

    origins = [_normalize_origin(PINNED_CHROME_ID)]
    for cid in chrome_ids:
        if cid:
            origins.append(_normalize_origin(cid))
    # de-dup while preserving order
    seen: set[str] = set()
    origins = [o for o in origins if not (o in seen or seen.add(o))]

    chrome_manifest = {
        "name": "browser_outo",
        "description": "browser-outo native host",
        "path": str(wrapper),
        "type": "stdio",
        "allowed_origins": origins,
    }
    ff_manifest = {
        "name": "browser_outo",
        "description": "browser-outo native host",
        "path": str(wrapper),
        "type": "stdio",
        "allowed_extensions": [FIREFOX_ADDON_ID],
    }

    written: list[str] = [str(wrapper)]
    for d in _chrome_manifest_dirs():
        d.mkdir(parents=True, exist_ok=True)
        p = d / "browser_outo.json"
        p.write_text(json.dumps(chrome_manifest, indent=2) + "\n", encoding="utf-8")
        written.append(str(p))
    for d in _firefox_manifest_dirs():
        d.mkdir(parents=True, exist_ok=True)
        p = d / "browser_outo.json"
        p.write_text(json.dumps(ff_manifest, indent=2) + "\n", encoding="utf-8")
        written.append(str(p))
    return written
