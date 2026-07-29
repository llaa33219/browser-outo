"""All-asyncio native messaging host for browser-outo.

Spawned by Chrome/Firefox via a native-messaging manifest. Talks to the
extension over stdio (uint32-LE length + UTF-8 JSON framing) and exposes a
Unix domain socket at ``token_dir()/native/<browser>.sock`` that the CLI
connects to.

Single event loop, no threads. At startup the original stdout fd is duped and
``sys.stdout`` is replaced with ``/dev/null`` so stray ``print`` calls can
never corrupt the framing stream; all frame writes go through the preserved
fd. All logging goes to stderr.

Entry point: ``python -u -m browser_outo.native_host``.

SIZE_OK: this module is a single cohesive process state machine that splices
the stdio (extension) channel to the socket (CLI) channel. Splitting the
listener/framer/host into separate modules would fragment one indivisible
responsibility across artificial seams.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import hmac
import json
import logging
import os
import secrets
import socket
import stat
import struct
import sys
from pathlib import Path
from typing import Any

from .auth import token_dir

logger = logging.getLogger("browser_outo.native_host")

PINNED_CHROME_ID = "jdpmmcbgncnlmcaaggkfccdmehkgnkjc"
FIREFOX_ADDON_ID = "browser-outo@localhost"

DEFAULT_COMMAND_TIMEOUT = 30.0
# A connected CLI must send its auth frame within this window.
AUTH_DEADLINE = 5.0


# --------------------------------------------------------------------------- #
# argv + paths
# --------------------------------------------------------------------------- #


class ArgvError(Exception):
    """Raised when the browser-supplied argv does not identify this host."""


def parse_argv(argv: list[str]) -> str:
    """Return the browser name (``chrome``/``firefox``) implied by argv.

    Chrome passes the extension origin as argv[1] (``chrome-extension://...``).
    Firefox passes the manifest path as argv[1] and the add-on id as argv[2].
    Anything else is rejected so the browser surfaces a host-launch failure
    rather than silently binding a socket for the wrong consumer.
    """
    if len(argv) >= 2:
        origin = argv[1]
        if origin.startswith("chrome-extension://"):
            return "chrome"
        if origin.startswith("moz-extension://"):
            return "firefox"
    if len(argv) >= 3 and argv[2] == FIREFOX_ADDON_ID:
        return "firefox"
    if len(argv) >= 2 and "native-messaging-hosts" in argv[1]:
        return "firefox"
    raise ArgvError(f"unrecognized argv: {argv[1:]}")


def native_socket_path(browser: str) -> Path:
    return token_dir() / "native" / f"{browser}.sock"


def native_token_path(browser: str) -> Path:
    return token_dir() / f"native-token-{browser}"


def write_native_token(browser: str) -> str:
    """Generate and persist the per-browser CLI auth token (mode 0600).

    Mirrors ``auth.write_token``'s create-then-chmod-race avoidance: the file
    is opened with ``O_CREAT`` and mode 0600 so it never exists on disk with
    looser permissions.
    """
    token = secrets.token_urlsafe(32)
    path = native_token_path(browser)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, token.encode("utf-8"))
    finally:
        os.close(fd)
    return token


def _remove_native_token(browser: str) -> None:
    with contextlib.suppress(OSError):
        native_token_path(browser).unlink()


# --------------------------------------------------------------------------- #
# Listener: bind with liveness probe + peer-credential check
# --------------------------------------------------------------------------- #


def make_listener(sock_path: Path) -> socket.socket | None:
    """Bind the CLI-facing unix socket.

    Returns the listening socket, or ``None`` if a live host already owns the
    path (caller exits 0 quietly in that case). Stale leftover socket files
    (bind ``EADDRINUSE`` + probe ``ECONNREFUSED``) are unlinked and the bind
    is retried exactly once. There is never an unconditional unlink.
    """
    sock_path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(sock_path.parent, 0o700)

    def _new() -> socket.socket:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        if sys.platform == "linux":
            # Ask the kernel to deliver SCM_CREDENTIALS on accepted conns.
            # SO_PEERCRED queries do not strictly require it, but the spec
            # mandates setting it on the listener and it hardens introspection.
            with contextlib.suppress(OSError):
                s.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        return s

    sock = _new()
    try:
        sock.bind(str(sock_path))
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            sock.close()
            raise
        # Probe whether something is actually listening.
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.settimeout(0.5)
        try:
            probe.connect(str(sock_path))
            probe.close()
            sock.close()
            return None  # a server is accept()ing — leave it alone
        except OSError:
            probe.close()
            with contextlib.suppress(OSError):
                sock_path.unlink()
            sock = _new()
            sock.bind(str(sock_path))  # may raise; surfaces a real conflict

    os.chmod(sock_path, 0o600)
    sock.listen()
    return sock


def peer_ok(writer: asyncio.StreamWriter) -> bool:
    """True if the accepted peer runs as the same uid as this process.

    Linux: ``SO_PEERCRED`` (authoritative). Other platforms: allowed with a
    stderr warning (documented limitation — same-UID enforcement relies on the
    0700 socket directory perms there).
    """
    sock = writer.get_extra_info("socket")
    if sock is None:
        return True
    if sys.platform == "linux":
        try:
            data = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("iII"))
        except OSError:
            return False
        _pid, uid, _gid = struct.unpack("iII", data)
        return uid == os.geteuid()
    logger.debug("peercred: not enforced on %s", sys.platform)
    return True


# --------------------------------------------------------------------------- #
# Framing helpers
# --------------------------------------------------------------------------- #


async def read_json_frame(reader: asyncio.StreamReader) -> dict[str, Any]:
    """Read one uint32-LE-length + UTF-8-JSON frame, tolerating short reads."""
    raw_len = await reader.readexactly(4)
    (length,) = struct.unpack("<I", raw_len)
    payload = await reader.readexactly(length)
    return json.loads(payload.decode("utf-8"))


async def write_json_frame(writer: asyncio.StreamWriter, msg: dict[str, Any]) -> None:
    payload = json.dumps(msg).encode("utf-8")
    writer.write(struct.pack("<I", len(payload)))
    writer.write(payload)
    await writer.drain()


def write_stdout_fd(fd: int, msg: dict[str, Any]) -> None:
    """Blocking framed write to the preserved stdout fd (extension channel).

    Only used for extension-bound frames (registered reply, command relay,
    pong) which are always small (well under native-messaging's 1 MB host→ext
    cap). The extension drains its stdin promptly so this does not stall the
    loop. A partial write is retried until the whole frame is flushed.
    """
    payload = json.dumps(msg).encode("utf-8")
    frame = struct.pack("<I", len(payload)) + payload
    view = memoryview(frame)
    sent = 0
    while sent < len(frame):
        n = os.write(fd, view[sent:])
        if n <= 0:
            raise BrokenPipeError("extension stdout closed")
        sent += n


# --------------------------------------------------------------------------- #
# Host
# --------------------------------------------------------------------------- #


class NativeHost:
    """Splices the stdio extension channel to the socket CLI channel."""

    def __init__(
        self,
        browser: str,
        stdout_fd: int,
        native_token: str,
        stdin_reader: asyncio.StreamReader,
    ) -> None:
        self.browser = browser
        self.stdout_fd = stdout_fd
        self.native_token = native_token
        self.stdin = stdin_reader
        self.registered = False
        # req_id -> (future awaiting extension response, owning client writer)
        self.pending: dict[str, tuple[asyncio.Future[dict[str, Any]], asyncio.StreamWriter]] = {}
        self.server: asyncio.Server | None = None
        self._shutting_down = False

    async def run(self) -> int:
        sock_path = native_socket_path(self.browser)
        listener = make_listener(sock_path)
        if listener is None:
            logger.info("another live host owns %s; exiting", sock_path)
            return 0
        try:
            self.server = await asyncio.start_unix_server(self._serve_client, sock=listener)
            logger.info("listening on %s (browser=%s)", sock_path, self.browser)
            await self._stdio_loop()
        finally:
            await self._shutdown()
        return 0

    # --------------------------- extension (stdio) ------------------------ #

    async def _stdio_loop(self) -> None:
        while True:
            try:
                msg = await read_json_frame(self.stdin)
            except asyncio.IncompleteReadError:
                logger.info("extension stdin EOF; disconnecting")
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("stdio: dropping malformed frame", exc_info=True)
                continue
            if isinstance(msg, dict):
                await self._handle_extension_frame(msg)

    async def _handle_extension_frame(self, msg: dict[str, Any]) -> None:
        mtype = msg.get("type")
        if mtype == "register":
            self.registered = True
            write_stdout_fd(self.stdout_fd, {"type": "registered", "ext_id": self.browser})
            logger.info("extension registered (browser=%s)", self.browser)
        elif mtype == "response":
            rid = msg.get("req_id")
            entry = self.pending.pop(rid, None) if isinstance(rid, str) else None
            if entry is not None and not entry[0].done():
                entry[0].set_result(msg)
        elif mtype == "ping":
            write_stdout_fd(self.stdout_fd, {"type": "pong"})
        elif mtype == "pong":
            pass
        # unknown types tolerated silently

    # ------------------------------- CLI socket --------------------------- #

    async def _serve_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if not peer_ok(writer):
            writer.close()
            return
        try:
            await self._client_loop(reader, writer)
        except asyncio.IncompleteReadError:
            pass  # client gone
        except (ConnectionResetError, BrokenPipeError):
            pass
        except Exception:
            logger.warning("client handler error", exc_info=True)
        finally:
            self._drop_client(writer)

    async def _client_loop(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        # First frame MUST be auth.
        try:
            auth = await asyncio.wait_for(read_json_frame(reader), timeout=AUTH_DEADLINE)
        except asyncio.TimeoutError:
            return
        token = auth.get("token") if isinstance(auth, dict) else None
        if not isinstance(token, str) or not hmac.compare_digest(token, self.native_token):
            logger.warning("client auth rejected")
            return
        # Authenticated — serve frames until EOF.
        while True:
            msg = await read_json_frame(reader)
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "ping":
                await write_json_frame(writer, {"type": "pong"})
            elif mtype == "command":
                await self._relay_command(writer, msg)
            # unknown types tolerated silently

    async def _relay_command(self, writer: asyncio.StreamWriter, msg: dict[str, Any]) -> None:
        rid = msg.get("req_id")
        if not isinstance(rid, str):
            return
        if not self.registered:
            await write_json_frame(
                writer, {"type": "response", "req_id": rid, "ok": False, "error": "extension not connected"}
            )
            return
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self.pending[rid] = (fut, writer)
        cmd = {
            "type": "command",
            "req_id": rid,
            "action": msg.get("action"),
            "params": msg.get("params") or {},
        }
        try:
            write_stdout_fd(self.stdout_fd, cmd)
        except BrokenPipeError:
            self.pending.pop(rid, None)
            await write_json_frame(
                writer, {"type": "response", "req_id": rid, "ok": False, "error": "extension disconnected"}
            )
            return
        timeout = float(msg.get("timeout") or DEFAULT_COMMAND_TIMEOUT)
        try:
            resp = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self.pending.pop(rid, None)
            resp = {"type": "response", "req_id": rid, "ok": False, "error": "timeout"}
        await write_json_frame(writer, resp)

    def _drop_client(self, writer: asyncio.StreamWriter) -> None:
        doomed = [rid for rid, (_f, w) in self.pending.items() if w is writer]
        for rid in doomed:
            entry = self.pending.pop(rid, None)
            if entry is not None and not entry[0].done():
                entry[0].set_result(
                    {"type": "response", "req_id": rid, "ok": False, "error": "client disconnected"}
                )
        with contextlib.suppress(Exception):
            writer.close()

    # ------------------------------- shutdown ----------------------------- #

    async def _shutdown(self) -> None:
        if self._shutting_down:
            return
        self._shutting_down = True
        # Fail every pending future (extension is gone / we are shutting down).
        for rid, (fut, _w) in list(self.pending.items()):
            if not fut.done():
                fut.set_result(
                    {"type": "response", "req_id": rid, "ok": False, "error": "extension disconnected"}
                )
        self.pending.clear()
        if self.server is not None:
            self.server.close()
            with contextlib.suppress(Exception):
                await self.server.wait_closed()
        with contextlib.suppress(OSError):
            native_socket_path(self.browser).unlink()
        _remove_native_token(self.browser)


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #


async def _amain(argv: list[str]) -> int:
    debug = bool(os.environ.get("BROWSER_OUTO_NATIVE_DEBUG"))
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.DEBUG if debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        browser = parse_argv(argv)
    except ArgvError as exc:
        # stderr is the only channel a misconfigured browser will see.
        logger.error("argv validation failed: %s", exc)
        return 1

    # Preserve the original stdout fd, then silence any future print()s.
    stdout_fd = os.dup(1)
    sys.stdout = open(os.devnull, "w")  # noqa: SIM115 — devnull lives for the process

    native_token = write_native_token(browser)
    logger.info("native token for %s written", browser)

    # The host is only meaningful when launched by a browser, which wires
    # stdin/stdout as anonymous pipes. A non-pipe stdin (e.g. /dev/null or a
    # tty from accidental manual invocation) is not epoll-pollable and would
    # leave the read transport in a broken state, so refuse it up front.
    try:
        stdin_stat = os.fstat(0)
    except OSError as exc:
        logger.error("stdin not available: %s", exc)
        return 1
    if not stat.S_ISFIFO(stdin_stat.st_mode):
        logger.error(
            "stdin is not a pipe (mode=%o); this host must be launched by a "
            "browser via a native-messaging manifest, not run directly.",
            stdin_stat.st_mode,
        )
        return 1

    loop = asyncio.get_running_loop()
    stdin_reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(stdin_reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)

    host = NativeHost(browser, stdout_fd, native_token, stdin_reader)
    return await host.run()


def main() -> None:
    sys.exit(asyncio.run(_amain(sys.argv)))


if __name__ == "__main__":
    main()
