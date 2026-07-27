---
name: browser-outo
description: Drive the user's real, already-authenticated browser through a locally-installed extension. Use when the user needs to interact with websites, fill forms, click buttons, take screenshots, extract data, test web apps, or automate any browser task where they are already logged in. Requires the browser-outo server running locally and the browser-outo extension installed in the user's browser. Triggers include "open this site", "log in and click X", "fill out this form", "screenshot my dashboard", "scrape this page", "test this web app", "automate browser actions", and any task that needs the user's real browser session.
---

# browser-outo

Drive the user's real, already-authenticated browser from a local CLI/agent through a WebSocket-connected extension. Cookies, logins, and permissions are preserved because the extension runs the user's actual browser.

## Architecture

`browser-outo serve` runs a local HTTP/WebSocket server on `127.0.0.1:11681`. A browser extension (Chrome MV3 or Firefox MV2) installed in the user's browser opens an outbound WebSocket to that server and is assigned a numeric `EXT_ID`. All commands take the form `browser-outo <cmd> EXT_ID ...`. Multiple browsers/extensions can connect at once; each gets its own `EXT_ID`. Network traffic stays local.

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

Then start the server:

```bash
browser-outo serve &
```

Run it in the background. The extension auto-connects on load; no pairing code.

**Be patient after startup.** The extension discovers the server with a retry loop (backoff up to 30s), and the first connection after a server (re)start can take anywhere from a few seconds to ~2 minutes depending on where the retry timer is. If `browser-outo extensions` returns an empty list, do NOT give up — wait 30 seconds and try again, repeating for up to 2 minutes. Only then suspect a real problem (extension not installed, browser closed, wrong port).

## Command Reference

### Server

```bash
browser-outo serve [--port 11681] [--host 127.0.0.1]
```

Start the local server. Defaults bind to `127.0.0.1:11681`. After starting, confirm it is up with `curl http://127.0.0.1:11681/` or simply run `browser-outo extensions` (a connection error means the server is not running — start it).

### Discovery

```bash
browser-outo extensions
```

List connected extensions. Output: `EXT_ID, browser, version, connected_at`. **Always run this first** to discover available `EXT_ID`s. Empty list means the extension is not installed or no browser is open.

### Tabs

```bash
browser-outo open EXT_ID URL [--background]
```

Open a new tab at `URL`. Prints the new `TAB_ID`. `--background` opens the tab without focusing it.

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

If connection error: server is not running. Start it yourself in the background:

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
