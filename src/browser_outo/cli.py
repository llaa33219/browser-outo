"""Command-line interface for browser-outo.

Transport is **native-first**: when native-messaging host sockets exist under
``token_dir()/native/`` the CLI talks to them directly over a Unix domain
socket (per-command auth token). When no sockets exist it falls back to the
original HTTP+Bearer path against ``browser-outo serve``. Every command works
identically in either mode; only the ``ext`` argument's accepted shape differs
— native mode takes a browser name (``chrome``/``firefox``) or a 1-based index
into the sorted socket list, while HTTP fallback takes the numeric ``ext_id``
the server assigned.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path
from typing import Any, Iterable

import click
import httpx

from . import _native
from .auth import read_token, resolve_port

DEFAULT_PORT = 11681
DEFAULT_HOST = "127.0.0.1"
DEFAULT_TIMEOUT = 60.0  # client-side HTTP timeout (> server's 30s default)

# Hosts considered loopback. Binding anything else without ``--allow-remote``
# is refused — the server is per-run-token authed, not network authed.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


# --------------------------------------------------------------------------- #
# Group + port resolution
# --------------------------------------------------------------------------- #


@click.group()
@click.option(
    "--port",
    "port",
    type=int,
    default=None,
    help="Server port (env BROWSER_OUTO_PORT, default 11681).",
)
@click.pass_context
def main(ctx: click.Context, port: int | None) -> None:
    """browser-outo — drive a real browser from AI agents."""
    ctx.ensure_object(dict)
    ctx.obj["port"] = resolve_port(port, DEFAULT_PORT)


# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #


def _die_not_running(port: int) -> "Any":
    click.echo(
        f"browser-outo server not running on port {port}. "
        f"Start it with: browser-outo serve",
        err=True,
    )
    sys.exit(1)


def _request(
    ctx: click.Context, method: str, path: str, json_body: dict | None = None
) -> httpx.Response:
    port = ctx.obj["port"]
    url = f"http://127.0.0.1:{port}{path}"
    headers = _auth_headers(port)
    try:
        with httpx.Client(timeout=DEFAULT_TIMEOUT, headers=headers) as client:
            if method == "GET":
                resp = client.get(url)
            else:
                resp = client.post(url, json=json_body)
    except httpx.ConnectError:
        _die_not_running(port)
    except httpx.HTTPError as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)

    if resp.status_code == 401:
        click.echo(
            "browser-outo server rejected the request (401). The auth token "
            "is missing or stale.\nRestart `browser-outo serve` to refresh it.",
            err=True,
        )
        sys.exit(1)
    return resp


def _auth_headers(port: int) -> dict[str, str]:
    """Bearer header for the token file on ``port``, or empty dict.

    Empty dict (no Authorization header) when the token file is missing —
    the server will return 401 and the caller prints the restart hint.
    """
    token = read_token(port)
    if token is None:
        return {}
    return {"Authorization": f"Bearer {token}"}


def _unwrap(resp: httpx.Response) -> dict[str, Any]:
    """Parse a server response, exiting on any error envelope."""
    try:
        data = resp.json()
    except Exception:
        click.echo(f"Error: server returned status {resp.status_code}", err=True)
        sys.exit(1)

    if not isinstance(data, dict) or not data.get("ok", False):
        err = (
            data.get("error", f"unexpected server response: {data!r}")
            if isinstance(data, dict)
            else "unexpected server response"
        )
        click.echo(f"Error: {err}", err=True)
        sys.exit(1)
    return data


def _command(
    ctx: click.Context,
    ext_id: str,
    action: str,
    params: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Dispatch a command via native socket first, HTTP fallback second.

    Returns the command's ``data`` payload on success and exits the process
    with a human-readable message on any failure (transport lost, timeout,
    extension error, or HTTP error). Native transport-lost mid-command is
    distinguished with exit code 3 so an agent does not blindly retry an
    operation whose side effects may already have run.
    """
    try:
        native = _native.native_command(ext_id, action, params or {}, timeout)
    except _native.TransportLost:
        click.echo(
            "command outcome unknown (transport lost; side effects may have happened)",
            err=True,
        )
        sys.exit(3)
    except (FileNotFoundError, ValueError) as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)
    if native is not None:
        if not native.get("ok", False):
            click.echo(f"Error: {native.get('error', 'unknown error')}", err=True)
            sys.exit(1)
        return native.get("data") or {}

    # No native sockets — fall back to the HTTP+Bearer path.
    try:
        ext_id_int = int(ext_id)
    except (TypeError, ValueError):
        click.echo(
            f"Error: {ext_id!r} is not a valid extension id "
            "(no native sockets present; HTTP fallback needs a numeric ext_id).",
            err=True,
        )
        sys.exit(1)
    body = {
        "ext_id": ext_id_int,
        "action": action,
        "params": params or {},
        "timeout": timeout,
    }
    resp = _request(ctx, "POST", "/api/command", body)
    return _unwrap(resp)["data"]


# --------------------------------------------------------------------------- #
# Output helpers
# --------------------------------------------------------------------------- #


def _print_table(rows: list[list[str]]) -> None:
    """Plain aligned table. First row is the header."""
    if not rows:
        return
    ncol = len(rows[0])
    widths = [max(len(str(r[i])) for r in rows) for i in range(ncol)]
    for idx, row in enumerate(rows):
        line = "  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(row))
        click.echo(line)
        if idx == 0:
            click.echo("  ".join("-" * widths[i] for i in range(ncol)))


def _truncate(text: Any, limit: int = 60) -> str:
    s = (str(text) if text is not None else "").strip()
    if len(s) <= limit:
        return s
    return s[: max(limit - 3, 1)] + "..."


def _print_elements(elements: Iterable[dict[str, Any]], show_bbox: bool = False) -> None:
    els = list(elements)
    has_iframe = any(el.get("frame") for el in els)
    header = ["index", "tag", "role", "text"]
    if show_bbox:
        header.append("bbox(x,y,w,h)")
    else:
        header.append("selector")
    if has_iframe:
        header.append("iframe")
    rows: list[list[str]] = [header]
    for el in els:
        row = [
            str(el.get("index", "")),
            str(el.get("tag", "")),
            str(el.get("role", "")),
            _truncate(el.get("text", ""), 60),
        ]
        if show_bbox:
            bb = el.get("bbox") or {}
            row.append(
                f"{bb.get('x', 0):.0f},{bb.get('y', 0):.0f},{bb.get('w', 0):.0f},{bb.get('h', 0):.0f}"
            )
        else:
            row.append(str(el.get("selector", "")))
        if has_iframe:
            row.append(_truncate(el.get("frame_url", "") or "", 50) if el.get("frame") else "")
        rows.append(row)
    if not els:
        click.echo("(no elements)")
        return
    _print_table(rows)


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #


@main.command()
@click.option("--port", "port", type=int, default=None,
              help="Port to listen on (env BROWSER_OUTO_PORT, default 11681).")
@click.option("--host", default=DEFAULT_HOST, help="Host to bind.")
@click.option("--allow-remote", is_flag=True,
              help="Allow binding to non-loopback hosts (NOT recommended; "
                   "the server is per-run-token authed, not network authed).")
def serve(port: int | None, host: str, allow_remote: bool) -> None:
    """Run the browser-outo server."""
    if not allow_remote and host not in _LOOPBACK_HOSTS:
        click.echo(
            f"Refusing to bind non-loopback host {host!r}. The browser-outo "
            "server trusts any caller with the per-run token, so exposing it "
            "to the network is unsafe.\nPass --allow-remote to override.",
            err=True,
        )
        sys.exit(1)

    import uvicorn

    from .server import create_app

    final_port = resolve_port(port, DEFAULT_PORT)
    app = create_app(final_port)
    uvicorn.run(app, host=host, port=final_port, log_level="info")


@main.command(name="install-native")
@click.option(
    "--chrome-extension-id",
    "chrome_ids",
    multiple=True,
    help="Additional Chrome extension origin/id to allow (e.g. an unpacked dev "
    "id). May be repeated. The pinned store id is always included.",
)
def install_native(chrome_ids: tuple[str, ...]) -> None:
    """Write the native-messaging wrapper script and browser manifests."""
    if sys.platform == "win32":
        click.echo(
            "Windows native messaging is not supported; use WS mode "
            "(browser-outo serve). The extension falls back automatically."
        )
        return
    written = _native.install_native(chrome_ids)
    for p in written:
        click.echo(f"wrote: {p}")
    click.echo(
        "\nDone. Fully quit and restart Chrome/Chromium/Firefox (or reload the "
        "extension) so they pick up the new native host."
    )


@main.command()
@click.pass_context
def extensions(ctx: click.Context) -> None:
    """List connected extensions."""
    sockets = _native.native_sockets()
    if sockets:
        rows = [["ext_id", "browser", "transport", "status"]]
        for idx, p in enumerate(sorted(sockets), 1):
            browser = p.stem
            alive = _native.native_alive(browser)
            rows.append([str(idx), browser, "native", "live" if alive else "stale"])
        _print_table(rows)
        return
    resp = _request(ctx, "GET", "/api/extensions")
    data = _unwrap(resp)
    exts = data.get("data", [])
    if not exts:
        click.echo("No extensions connected.")
        return
    rows = [["ext_id", "browser", "ext_version", "connected_at", "transport"]]
    for e in exts:
        rows.append(
            [
                str(e.get("ext_id", "")),
                str(e.get("browser", "")),
                str(e.get("ext_version", "")),
                str(e.get("connected_at", "")),
                "websocket",
            ]
        )
    _print_table(rows)


@main.command(name="open")
@click.argument("ext_id")
@click.argument("url")
@click.option("--background", is_flag=True, help="Open the tab inactive.")
@click.pass_context
def open_cmd(ctx: click.Context, ext_id: str, url: str, background: bool) -> None:
    """Open a URL in a new tab."""
    data = _command(
        ctx, ext_id, "open_tab", {"url": url, "active": not background}
    )
    click.echo(f"Opened tab {data.get('tab_id')} for extension {ext_id}")


@main.command()
@click.argument("ext_id")
@click.pass_context
def tabs(ctx: click.Context, ext_id: str) -> None:
    """List tabs in an extension."""
    data = _command(ctx, ext_id, "list_tabs", {})
    tab_list = data.get("tabs", [])
    if not tab_list:
        click.echo("No tabs.")
        return
    rows = [["tab_id", "active", "title", "url"]]
    for t in tab_list:
        mark = "*" if t.get("active") else ""
        rows.append(
            [
                str(t.get("tab_id", "")),
                mark,
                str(t.get("title", "")),
                str(t.get("url", "")),
            ]
        )
    _print_table(rows)


@main.command()
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.option("-o", "--output", "output", type=click.Path(), default=None,
              help="Write HTML to this file instead of stdout.")
@click.pass_context
def html(ctx: click.Context, ext_id: str, tab_id: int, output: str | None) -> None:
    """Fetch rendered HTML of a tab."""
    data = _command(ctx, ext_id, "get_html", {"tab_id": tab_id})
    text = str(data.get("html", ""))
    if output:
        Path(output).write_text(text, encoding="utf-8")
        click.echo(f"Wrote {len(text)} chars to {output}")
    else:
        click.echo(text)


@main.command()
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.option("--level", default=None, help="Filter by level (error/warn/info/log/...).")
@click.pass_context
def console(ctx: click.Context, ext_id: str, tab_id: int, level: str | None) -> None:
    """Fetch console log of a tab."""
    data = _command(ctx, ext_id, "get_console", {"tab_id": tab_id})
    entries = data.get("entries", [])
    if level:
        entries = [
            e for e in entries if str(e.get("level", "")).lower() == level.lower()
        ]
    if not entries:
        click.echo("(no console entries)")
        return
    for e in entries:
        click.echo(
            f"[{e.get('level', '')}] {e.get('timestamp', '')} {e.get('text', '')}"
        )


@main.command()
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.option("--bbox", is_flag=True, help="Show absolute viewport bounding boxes instead of selectors")
@click.pass_context
def elements(ctx: click.Context, ext_id: str, tab_id: int, bbox: bool) -> None:
    """List interactive elements in a tab."""
    data = _command(ctx, ext_id, "list_elements", {"tab_id": tab_id})
    _print_elements(data.get("elements", []), show_bbox=bbox)


@main.command(name="click")
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.argument("index", type=int)
@click.pass_context
def click_cmd(ctx: click.Context, ext_id: str, tab_id: int, index: int) -> None:
    """Click element at INDEX in a tab."""
    _command(
        ctx,
        ext_id,
        "interact",
        {"tab_id": tab_id, "index": index, "action": "click"},
    )
    click.echo("ok")


@main.command(name="type")
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.argument("index", type=int)
@click.argument("text")
@click.option("--enter", is_flag=True, help="Press Enter after typing.")
@click.pass_context
def type_cmd(
    ctx: click.Context, ext_id: str, tab_id: int, index: int, text: str, enter: bool
) -> None:
    """Type TEXT into element at INDEX."""
    _command(
        ctx,
        ext_id,
        "interact",
        {"tab_id": tab_id, "index": index, "action": "type", "text": text},
    )
    if enter:
        _command(ctx, ext_id, "press_keys", {"tab_id": tab_id, "keys": "Enter"})
    click.echo("ok")


@main.command()
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.argument("index", type=int)
@click.pass_context
def hover(ctx: click.Context, ext_id: str, tab_id: int, index: int) -> None:
    """Hover element at INDEX in a tab."""
    _command(
        ctx,
        ext_id,
        "interact",
        {"tab_id": tab_id, "index": index, "action": "hover"},
    )
    click.echo("ok")


@main.command(name="select")
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.argument("index", type=int)
@click.argument("value")
@click.pass_context
def select_cmd(
    ctx: click.Context, ext_id: str, tab_id: int, index: int, value: str
) -> None:
    """Select VALUE in the element at INDEX."""
    _command(
        ctx,
        ext_id,
        "interact",
        {"tab_id": tab_id, "index": index, "action": "select", "value": value},
    )
    click.echo("ok")


@main.command()
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.argument("combo")
@click.pass_context
def keys(ctx: click.Context, ext_id: str, tab_id: int, combo: str) -> None:
    """Press a key combo, e.g. \"Control+Shift+K\", \"Enter\", \"Alt+ArrowLeft\"."""
    _command(ctx, ext_id, "press_keys", {"tab_id": tab_id, "keys": combo})
    click.echo("ok")


@main.command(name="click-xy")
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.argument("x", type=float)
@click.argument("y", type=float)
@click.pass_context
def click_xy(ctx: click.Context, ext_id: str, tab_id: int, x: float, y: float) -> None:
    """Click at viewport coordinates (X, Y)."""
    data = _command(ctx, ext_id, "click_xy", {"tab_id": tab_id, "x": x, "y": y})
    tag = data.get("tag", "?")
    text = (data.get("text") or "")[:60]
    click.echo(f"clicked <{tag}> {text}".rstrip())


@main.command(context_settings={"allow_interspersed_args": False})
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.argument("dy", type=int)
@click.option("--dx", type=int, default=0, help="Horizontal scroll pixels (positive = right)")
@click.pass_context
def scroll(ctx: click.Context, ext_id: str, tab_id: int, dy: int, dx: int) -> None:
    """Scroll the tab by DY pixels (negative = up)."""
    data = _command(ctx, ext_id, "scroll", {"tab_id": tab_id, "dx": dx, "dy": dy})
    click.echo(f"scroll position: x={data.get('x', 0)} y={data.get('y', 0)}")


@main.command()
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.argument("path", type=click.Path())
@click.pass_context
def screenshot(ctx: click.Context, ext_id: str, tab_id: int, path: str) -> None:
    """Capture a screenshot and write it to PATH."""
    data = _command(ctx, ext_id, "screenshot", {"tab_id": tab_id}, timeout=60.0)
    png = base64.b64decode(str(data.get("png_base64", "")))
    Path(path).write_bytes(png)
    click.echo(f"Wrote {len(png)} bytes to {path}")


@main.command()
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.argument("path", type=click.Path())
@click.pass_context
def annotate(ctx: click.Context, ext_id: str, tab_id: int, path: str) -> None:
    """Capture an annotated screenshot to PATH and print the elements table."""
    data = _command(ctx, ext_id, "annotate", {"tab_id": tab_id}, timeout=60.0)
    png = base64.b64decode(str(data.get("png_base64", "")))
    Path(path).write_bytes(png)
    click.echo(f"Wrote {len(png)} bytes to {path}")
    _print_elements(data.get("elements", []))


@main.command()
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.option("-o", "--output", "output", type=click.Path(), default=None,
              help="Write tree to this file instead of stdout.")
@click.pass_context
def a11y(ctx: click.Context, ext_id: str, tab_id: int, output: str | None) -> None:
    """Fetch the accessibility tree of a tab."""
    data = _command(ctx, ext_id, "get_a11y", {"tab_id": tab_id})
    tree = str(data.get("tree", ""))
    if output:
        Path(output).write_text(tree, encoding="utf-8")
        click.echo(f"Wrote {len(tree)} chars to {output}")
    else:
        click.echo(tree)


@main.command(name="close")
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.pass_context
def close_cmd(ctx: click.Context, ext_id: str, tab_id: int) -> None:
    """Close a tab."""
    _command(ctx, ext_id, "close_tab", {"tab_id": tab_id})
    click.echo("ok")


@main.command()
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.pass_context
def reload(ctx: click.Context, ext_id: str, tab_id: int) -> None:
    """Reload a tab."""
    _command(ctx, ext_id, "reload_tab", {"tab_id": tab_id})
    click.echo("ok")


@main.command()
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.pass_context
def back(ctx: click.Context, ext_id: str, tab_id: int) -> None:
    """Go back in a tab's history."""
    _command(ctx, ext_id, "go_back", {"tab_id": tab_id})
    click.echo("ok")


@main.command()
@click.argument("ext_id")
@click.argument("tab_id", type=int)
@click.pass_context
def forward(ctx: click.Context, ext_id: str, tab_id: int) -> None:
    """Go forward in a tab's history."""
    _command(ctx, ext_id, "go_forward", {"tab_id": tab_id})
    click.echo("ok")


if __name__ == "__main__":
    main()
