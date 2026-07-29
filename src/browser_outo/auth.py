"""Per-run auth token: cross-platform storage + port resolution.

The server writes a fresh ``secrets.token_urlsafe(32)`` token to a per-user
file on every startup. The filename includes the resolved port so multiple
servers don't collide. The CLI reads the same file for the port it talks to
and sends ``Authorization: Bearer <token>`` on every request.

Threat model: drive-by web pages. Any website open in the browser can fetch
``http://127.0.0.1:<port>/api/...``. Without a token, it could drive the
user's real logged-in browser. Same-UID local malware can read the token
file and is OUT of scope for this phase — file perms (0700 dir, 0600 file)
are best-effort against other users on a shared host, not against the
owner's own processes.
"""

from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

# Port resolution precedence: --port flag > BROWSER_OUTO_PORT env > default.
# Shared by server (token filename) and CLI (token lookup) so they cannot
# drift out of sync on which file to use.
_ENV_PORT = "BROWSER_OUTO_PORT"


def resolve_port(cli_port: int | None, default_port: int) -> int:
    """Final port after flag/env/default precedence.

    A non-None ``cli_port`` always wins. Otherwise we honor
    ``BROWSER_OUTO_PORT`` (parsed as int). Garbage in the env var falls back
    to ``default_port`` rather than crashing — matches the existing CLI group
    behavior in ``cli.main``.
    """
    if cli_port is not None:
        return cli_port
    env_raw = os.environ.get(_ENV_PORT)
    if env_raw:
        try:
            return int(env_raw)
        except ValueError:
            return default_port
    return default_port


def token_dir() -> Path:
    """Cross-platform per-user directory holding ``token-<port>`` files.

    - Windows: ``%LOCALAPPDATA%\\browser-outo`` (fallback
      ``~/AppData/Local/browser-outo``). No chmod — per-user ACL is the
      protection on win32.
    - macOS: ``~/Library/Application Support/browser-outo``.
    - Linux/other POSIX: ``$XDG_RUNTIME_DIR/browser-outo`` ONLY IF that env
      var is set AND the dir already exists AND it is owned by the current
      uid AND its mode has no group/other bits set. Otherwise we fall back
      to ``$XDG_STATE_HOME`` (or ``~/.local/state``) + ``/browser-outo``.

    On POSIX the returned dir is always ``mkdir(parents=True, exist_ok=True)``
    then ``os.chmod(dir, 0o700)`` so the perms are tightened even if the
    parent dir was loose.
    """
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA")
        if base:
            d = Path(base) / "browser-outo"
        else:
            d = Path.home() / "AppData" / "Local" / "browser-outo"
        d.mkdir(parents=True, exist_ok=True)
        # No chmod on win32 — per-user ACL inherited from %LOCALAPPDATA%.
        return d

    # POSIX path — prefer a pre-existing safe XDG_RUNTIME_DIR slot.
    xdg_runtime = os.environ.get("XDG_RUNTIME_DIR")
    if xdg_runtime:
        candidate = Path(xdg_runtime) / "browser-outo"
        try:
            st = candidate.stat()
        except OSError:
            # Doesn't exist or isn't accessible — fall through to state dir.
            st = None
        if st is not None and st.st_uid == os.geteuid() and (st.st_mode & 0o077) == 0:
            os.chmod(candidate, 0o700)
            return candidate

    state_base = os.environ.get("XDG_STATE_HOME")
    if state_base:
        d = Path(state_base) / "browser-outo"
    else:
        d = Path.home() / ".local" / "state" / "browser-outo"
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    return d


def token_path(port: int) -> Path:
    return token_dir() / f"token-{port}"


def write_token(port: int) -> tuple[str, Path]:
    """Generate a fresh token, persist it to ``token-<port>``, return it.

    On POSIX the file is opened with ``O_WRONLY|O_CREAT|O_TRUNC`` and mode
    ``0o600`` so it never appears on disk with looser perms (avoids the
    create-then-chmod race). On win32 a plain write is used — the per-user
    ACL on the parent dir is the protection.
    """
    token = secrets.token_urlsafe(32)
    path = token_path(port)
    if sys.platform == "win32":
        path.write_text(token, encoding="utf-8")
    else:
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        fd = os.open(path, flags, 0o600)
        try:
            os.write(fd, token.encode("utf-8"))
        finally:
            os.close(fd)
    return token, path


def read_token(port: int) -> str | None:
    """Read the persisted token for ``port``, or ``None`` if missing/unreadable.

    A missing file means the server was never started on this port (or was
    restarted and hasn't written yet). Callers should treat ``None`` as
    "unauthenticated request will be rejected by the server".
    """
    path = token_path(port)
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
