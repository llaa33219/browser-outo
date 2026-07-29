---
name: browser-outo
description: Drive the user's real, already-authenticated browser through the browser-outo extension. Use for browser tasks that need the user's existing tabs, sessions, and logins. Requires the browser-outo server and extension. Triggers include opening sites, filling forms, clicking, screenshots, extraction, testing, and browser automation.
---

# browser-outo

Use the browser-outo CLI to operate the user's connected browser. Commands use:

```text
browser-outo <command> EXT_ID ...
```

`EXT_ID` comes from `browser-outo extensions`. Multiple connected browsers get
different IDs.

## Setup

Check the CLI before each task:

```bash
command -v browser-outo
```

If missing, install it with `uv tool install browser-outo`, `pipx install
browser-outo`, or `pip install browser-outo`.

If the extension is missing, tell the user to install the browser-outo extension
from their browser's extension store.

Start the server:

```bash
browser-outo serve &
```

Default address: `127.0.0.1:11681`. If `serve` reports that the address is
already in use, keep the existing server and continue.

After startup, poll for the extension:

```bash
browser-outo extensions
```

The extension retries with backoff. An empty list may be normal for up to 30
seconds after startup or restart. Poll every 30 seconds for up to 2 minutes.
Only then report that the extension may be missing, the browser may be closed,
or the server may be using the wrong port.

## Command reference

### Server and discovery

```bash
browser-outo serve [--port 11681] [--host 127.0.0.1] [--allow-remote]
browser-outo extensions
```

`serve` starts the local server. `--allow-remote` is required for a non-loopback
host. `extensions` lists connected extension IDs, browsers, versions, and
connection times. Run it before browser commands.

### Tabs

```bash
browser-outo open EXT_ID URL [--background]
browser-outo tabs EXT_ID
browser-outo reload EXT_ID TAB_ID
browser-outo back EXT_ID TAB_ID
browser-outo forward EXT_ID TAB_ID
browser-outo close EXT_ID TAB_ID
```

`open` prints the new `TAB_ID`. `--background` avoids focusing the new tab.

### Inspection

```bash
browser-outo html EXT_ID TAB_ID [-o PATH]
browser-outo a11y EXT_ID TAB_ID [-o PATH]
browser-outo elements EXT_ID TAB_ID [--bbox]
browser-outo console EXT_ID TAB_ID [--level LEVEL]
browser-outo screenshot EXT_ID TAB_ID PATH
browser-outo annotate EXT_ID TAB_ID PATH
```

`elements` prints numbered visible interactive elements. Use those indices with
`click`, `type`, `hover`, and `select`. Add `--bbox` when coordinate bounds are
needed. `a11y` is the compact semantic view.
Prefer `a11y` or `html` for extraction. `screenshot` focuses the tab. `annotate`
prints the element table and writes a numbered image for visual targeting.
Console `LEVEL` can be `log`, `info`, `warn`, `error`, or `debug`.

### Interaction

```bash
browser-outo click EXT_ID TAB_ID INDEX
browser-outo type EXT_ID TAB_ID INDEX TEXT [--enter]
browser-outo hover EXT_ID TAB_ID INDEX
browser-outo select EXT_ID TAB_ID INDEX VALUE
browser-outo keys EXT_ID TAB_ID COMBO
browser-outo click-xy EXT_ID TAB_ID X Y
browser-outo scroll [--dx DX] EXT_ID TAB_ID DY
```

Use `click-xy` for canvas, SVG, or custom widgets. Coordinates are viewport
coordinates. Re-screenshot after scrolling. `keys` accepts combos such as
`Control+Shift+K`, `Enter`, `Alt+ArrowLeft`, and `Escape`.

## Operating procedure

1. Check the CLI, start the server, then run `extensions`.
2. Use `open` or `tabs` to select a target tab.
3. Run `a11y` or `elements` before interacting.
4. Re-run `elements` after every navigation, reload, or meaningful DOM update.
5. Perform the action, then inspect the result with `a11y`, `html`, screenshot, or
   console output as needed.

## Pitfalls that change behavior

- Element indices are per tab and expire after page changes or DOM updates. Never
  reuse an old index.
- Restricted pages such as `chrome://`, `about:`, browser error pages, and the
  browser extension store cannot be accessed. Navigate to a normal web page.
- Synthetic Enter events are ignored by some site widgets. Navigate directly to
  a search URL or click a suggestion instead.
- Site-defined keyboard shortcuts may ignore synthetic events. Use normal form
  interactions or `click-xy` when appropriate.
- Iframe elements are included in the numbered list, and coordinate clicks are
  routed into the deepest containing iframe with translated coordinates.
- `screenshot` activates the tab and the user will see the tab switch.
- If commands hang or return connection errors, restart with
  `browser-outo serve &`.
- For large HTML or accessibility output, use `-o PATH` and inspect the file.

