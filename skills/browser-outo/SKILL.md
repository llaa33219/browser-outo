---
name: browser-outo
description: Drive the user's real, already-authenticated browser through a locally-installed extension. Use when the user needs to interact with websites, fill forms, click buttons, take screenshots, extract data, test web apps, or automate any browser task where they are already logged in. Requires the browser-outo server running locally and the browser-outo extension installed in the user's browser. Triggers include "open this site", "log in and click X", "fill out this form", "screenshot my dashboard", "scrape this page", "test this web app", "automate browser actions", and any task that needs the user's real browser session.
---

# browser-outo

Drive the user's real, already-authenticated browser from a local CLI/agent through a WebSocket-connected extension. Cookies, logins, and permissions are preserved because the extension runs the user's actual browser.

## Architecture

Two transports; the native one is the default once `install-native` has been run.

- **Native (default):** the browser spawns the native host process and
  the extension talks to it over stdio. The same host also listens on a
  per-user Unix socket so the CLI can talk to it. No TCP port is
  involved.
- **WebSocket (fallback):** `browser-outo serve` runs an HTTP/WebSocket
  server on `127.0.0.1:11681` and the extension opens an outbound
  WebSocket to it. The server writes a per-run bearer token at startup;
  `/api/*` requires it, `GET /` is open as a health probe, `/ws` only
  accepts `chrome-extension://` and `moz-extension://` origins.

The CLI picks native mode automatically when a host socket is present,
otherwise it uses the WebSocket path. All commands take the form
`browser-outo <cmd> EXT_ID ...`. In native mode `EXT_ID` is the browser
name (`chrome`/`firefox`) or its numeric index from `extensions`; in
WebSocket mode it's a numeric ID assigned at connect time. Multiple
browsers/extensions can connect at once; each gets its own `EXT_ID`.
Network traffic stays local.

## Installation

First check whether the CLI is already installed:

```bash
command -v browser-outo
```

If it prints a path, skip installation. Otherwise install with any of:

```bash
uv tool install browser-outo    # preferred
pipx install browser-outo
pip install browser-outo
```

Load the extension:

- Chrome: `chrome://extensions` → enable Developer mode → "Load unpacked" → select `extension/chrome`.
- Firefox: `about:debugging` → "This Firefox" → "Load Temporary Add-on..." → select `extension/firefox/manifest.json`.

The Chrome extension is pinned to ID
`jdpmmcbgncnlmcaaggkfccdmehkgnkjc`. After pulling updates, hit
"Reload" on `chrome://extensions`; the first reload after the pin
landed will switch the on-screen ID to the pinned value, and the next
reload keeps it. The matching private key lives at
`~/.config/browser-outo/extension-key.pem` (mode `0600`) and is never
checked in.

Then, **once per machine**, enable the native transport:

```bash
browser-outo install-native
```

This writes the native host wrapper plus the Chrome and Firefox manifest
files (Linux: `~/.config/google-chrome/`, `~/.config/chromium/`,
`~/.mozilla/`, `~/.config/mozilla/`; macOS equivalents; Windows is
unsupported and stays on WebSocket). The command is idempotent —
re-run it any time to refresh. After it completes, reload the
extension again; from then on the extension console will show
`[outo] transport: native` and no TCP port is used.

`browser-outo serve` is only needed for the WebSocket fallback path —
if `install-native` is in place you can usually skip it. Keep it
available in case a browser falls back (manifest removed, locked-down
profile, etc.).

**Be patient after startup.** The extension discovers the server with a retry loop (backoff up to 30s), and the first connection after a server (re)start can take anywhere from a few seconds to ~2 minutes depending on where the retry timer is. If `browser-outo extensions` returns an empty list, do NOT give up — wait 30 seconds and try again, repeating for up to 2 minutes. Only then suspect a real problem (extension not installed, browser closed, wrong port).

## Command Reference

### Server

```bash
browser-outo serve [--port 11681] [--host 127.0.0.1] [--allow-remote]
```

Start the local WebSocket fallback server. Defaults bind to
`127.0.0.1:11681`; the server refuses a non-loopback bind unless you
pass `--allow-remote`. Each start writes a fresh per-run bearer token
(`token-<port>`) into a per-user state directory; the CLI picks it up
automatically, `/api/*` requires it, and `GET /` is open as a health
probe.

You do NOT need this when the native transport is in use — only start
it for the WebSocket fallback path. Confirm it is up with
`curl http://127.0.0.1:11681/` or simply run `browser-outo extensions`
(a connection error means the server is not running).

### Discovery

```bash
browser-outo extensions
```

List connected extensions. Output:
`EXT_ID, browser, version, connected_at, transport`. The `transport`
column is `native` or `websocket` and shows which path each extension
is currently using — prefer this over guessing from `EXT_ID` alone.
**Always run this first** to discover available `EXT_ID`s. Empty list
means the extension is not installed or no browser is open.

### Tabs

```bash
browser-outo open EXT_ID URL [--background]
```

Open a new tab at `URL`. Prints the new `TAB_ID`. `--background` opens the tab without focusing it. In native mode `EXT_ID` is the browser name (`chrome`/`firefox`) or the numeric index from `extensions`; in WebSocket mode it's the numeric ID assigned at connect time.

```bash
browser-outo tabs EXT_ID
```

List tabs for an extension. Output: `tab_id, active, title, url`.

### Inspection

```bash
browser-outo html EXT_ID TAB_ID [-o PATH]
```

Full page HTML. For large pages, write to a file with `-o` and grep it.

```bash
browser-outo console EXT_ID TAB_ID [--level LEVEL]
```

Console entries captured since page load. `--level` is one of `log`, `info`, `warn`, `error`, `debug`. Use `--level error` after actions to debug JS errors on the page.

```bash
browser-outo elements EXT_ID TAB_ID
```

Numbered list of visible interactive elements. Output: `index, tag, role, text, selector`. **This is the primary way to interact.** Use the `INDEX` from this output with `click`, `type`, `hover`, `select`.

```bash
browser-outo a11y EXT_ID TAB_ID [-o PATH]
```

Simplified accessibility tree (role + name, indented). Best compact structural overview — cheaper than `html` and more semantic than `elements`.

```bash
browser-outo screenshot EXT_ID TAB_ID PATH
```

PNG of the visible tab. **Activates and focuses the tab first** — the user will see the tab switch.

```bash
browser-outo annotate EXT_ID TAB_ID PATH
```

PNG with numbered red boxes over interactive elements, plus the element table printed to stdout. Best for vision-capable agents: run `annotate`, `Read` the PNG, map each number to the matching `INDEX`, then click/type by index.

### Interaction

```bash
browser-outo click EXT_ID TAB_ID INDEX
```

Click the element at `INDEX` from the most recent `elements` output.

```bash
browser-outo type EXT_ID TAB_ID INDEX TEXT [--enter]
```

Type `TEXT` into the input at `INDEX`. `--enter` presses Enter after typing.

```bash
browser-outo hover EXT_ID TAB_ID INDEX
```

Hover the element at `INDEX`.

```bash
browser-outo select EXT_ID TAB_ID INDEX VALUE
```

Choose a dropdown option by `VALUE` or visible text.

```bash
browser-outo keys EXT_ID TAB_ID COMBO
```

Send a key combo. Examples: `Control+Shift+K`, `Enter`, `Alt+ArrowLeft`, `Escape`. Works for most form-level interactions; some site-defined shortcuts (synthetic keyboard events) may not trigger.

```bash
browser-outo click-xy EXT_ID TAB_ID X Y
```

Click at viewport coordinates `(X, Y)`. Prints the tag/text of the element actually hit. Use when index-based clicking is impossible (canvas, SVG, custom widgets) — take a `screenshot`, pick coordinates, then `click-xy`. Coordinates are viewport-relative: re-screenshot after any scroll before clicking. If the point is inside an iframe (CAPTCHA widgets etc.), the click is automatically forwarded into the deepest containing frame with translated coordinates (nested iframes supported).

```bash
browser-outo scroll EXT_ID TAB_ID DY [--dx DX]
```

Scroll the tab by `DY` pixels (negative = up; `--dx` scrolls horizontally and must come BEFORE the positional args: `scroll --dx 150 EXT_ID TAB_ID 300`). Prints the resulting scroll position.

### Tab control

```bash
browser-outo reload  EXT_ID TAB_ID
browser-outo back    EXT_ID TAB_ID
browser-outo forward EXT_ID TAB_ID
browser-outo close   EXT_ID TAB_ID
```

`reload` resets element indices — re-run `elements` after a reload.

## Workflow Playbook

### 1. Startup check

```bash
command -v browser-outo    # if missing: uv tool install browser-outo (or pipx/pip)
browser-outo extensions
```

Look at the `transport` column first. If at least one row shows
`native`, you're done — the CLI is talking to the browser through the
native host and you do not need `browser-outo serve` at all.

If the list is empty, the install is incomplete. If you've never run
`browser-outo install-native`, do that once per machine first — it's
idempotent. If you have, reload the extension on
`chrome://extensions` / `about:debugging` and re-check.

If you intentionally skipped native install and want the WebSocket
path, start the server in the background:

```bash
browser-outo serve &
```

…then poll `browser-outo extensions` every ~30 seconds for up to 2 minutes — the extension's retry loop needs time to notice the server. Do not conclude failure on the first empty list.

If the list is STILL empty after 2 minutes: instruct the user to install/enable the extension and open any tab.

### 2. Basic browse

```bash
browser-outo extensions                              # get EXT_ID
browser-outo open $EXT_ID https://example.com        # get TAB_ID
browser-outo a11y   $EXT_ID $TAB_ID                  # or: elements
browser-outo click  $EXT_ID $TAB_ID 7
browser-outo elements $EXT_ID $TAB_ID                # re-enumerate after navigation
```

**Indices change on every page change, reload, or DOM update. Always re-enumerate before clicking.** Stale indices are the #1 failure mode.

### 3. Vision loop

```bash
browser-outo annotate $EXT_ID $TAB_ID /tmp/page.png
```

`Read` the PNG, map each red number to the matching `INDEX` from the printed element table, then `click`/`type` by index. Repeat.

### 4. Form filling

```bash
browser-outo elements $EXT_ID $TAB_ID
browser-outo type    $EXT_ID $TAB_ID 12 "alice@example.com"
browser-outo type    $EXT_ID $TAB_ID 14 "hunter2" --enter
browser-outo console $EXT_ID $TAB_ID --level error
```

### 5. Debugging a web app

```bash
browser-outo console $EXT_ID $TAB_ID --level error
browser-outo html    $EXT_ID $TAB_ID -o /tmp/page.html
grep -n 'expected-id' /tmp/page.html
```

### 6. Data extraction

Prefer `a11y` or `html` + parse over `screenshot`. The accessibility tree is the most compact and is sufficient for most structured extraction. Use `html -o` only when you need raw markup.

### 7. Pitfalls

- **Stale indices.** Re-run `elements` after every navigation, reload, or DOM update.
- **Inaccessible pages.** `chrome://`, `about:`, browser error pages (`DNS_PROBE_FINISHED_*`, `ERR_*`), and the Chrome Web Store are blocked from extension access — commands on them return "cannot access this tab (restricted page)".
- **Synthetic Enter ignored on some sites.** GitHub's search dialog (and similar React widgets) ignore untrusted synthetic keyboard events. Workaround: navigate the search URL directly (`open EXT_ID "https://github.com/search?q=QUERY&type=repositories"`) or click a suggestion item instead of pressing Enter.
- **Synthetic shortcuts.** Some site-defined keyboard shortcuts rely on events `keys` cannot synthesize; `keys` works for most form-level interactions only.
- **Screenshot side effect.** `screenshot` activates the tab; the user will see it switch.
- **Per-tab indices.** `INDEX` is scoped to the current `TAB_ID` and most recent `elements` call — never reuse indices across tabs.
- **Server gone.** If commands hang or fail with connection errors, the server may have stopped; restart with `browser-outo serve &`.
- **Exit code 3 — outcome unknown.** In native mode the transport can
  vanish mid-command (service worker restart, host crash, browser tab
  closed underneath the extension). When that happens, browser-outo
  exits with code 3 and prints that the side-effect status is
  unknown. Do NOT auto-retry clicks, opens, or any other
  non-idempotent action — the first attempt may already have landed.
  Verify the page state (`elements`, `tabs`, or `screenshot`) before
  deciding what to do next.
- **Chrome extension reload after update.** After pulling code
  changes, hit "Reload" on `chrome://extensions`. Skip the reload and
  the on-screen ID stays the old one, so the native messaging
  allowlist will silently reject the connection and the extension
  will fall back to WebSocket.
