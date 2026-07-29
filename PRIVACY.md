# Privacy Policy — browser-outo browser extension

**Effective date:** July 27, 2026

This privacy policy applies to the **browser-outo browser extension** (Chrome
and Firefox), distributed together with the open-source browser-outo project
at <https://github.com/llaa33219/browser-outo>.

## The short version

**This extension collects nothing.** No analytics, no telemetry, no accounts,
no tracking, no advertisements. All processing happens entirely on your own
computer, and no data ever leaves your machine.

## What the extension does

browser-outo is a tool that lets AI agents control your web browser. The
extension is the bridge between your browser and the browser-outo
process(es) that **you run yourself on your own computer** — either the
local WebSocket server on `127.0.0.1:11681` (the default fallback) or,
after `browser-outo install-native` is run, a browser-spawned native host
that the extension talks to over stdio with no TCP port at all. The
extension receives commands from that local process and executes them in
your browser: opening tabs, reading page content, clicking, typing,
scrolling, capturing screenshots, and similar actions.

## What data the extension accesses

To perform its function, the extension can access, **only when instructed by
you (through the local browser-outo server)**:

- The URLs and titles of your open tabs
- The content (HTML, text, console output) of pages you point it at
- Screenshots of tabs you point it at
- Input it performs on your behalf (clicks, keystrokes, form text)

## Where that data goes

**Only to local processes on your own computer.** The extension connects
to the browser-outo process you started on your machine: either the
WebSocket server on `127.0.0.1:11681` (loopback-only, requiring a
per-run bearer token and only accepting `chrome-extension://` or
`moz-extension://` origins on `/ws`) or, when
`browser-outo install-native` is in place, a native host that the browser
itself spawns and pipes the extension to over stdio. It does not connect
to any external server, cloud service, or third party. Everything the
extension reads stays inside your computer, under your control.

## What we do NOT do

- No data collection of any kind
- No transmission of browsing data to external parties
- No sale or sharing of data (there is nothing to sell or share)
- No analytics, crash reporting, or usage statistics
- No cookies or persistent storage of page content
- No accounts or sign-in

## Permissions justification

| Permission | Why it is needed |
|---|---|
| `tabs` | List, open, close, reload tabs and navigate tab history on your command |
| `<all_urls>` (host access) | Read page content and interact with elements on the pages you target, including inside iframes |
| `scripting` (Chrome) | Re-inject the content script into existing tabs after an extension update |
| `webNavigation` | Identify iframes so interactions can be routed to the correct frame |
| `alarms` (Chrome) | Keep the connection to your local server alive (MV3 service worker lifecycle) |
| `storage` (Chrome) | Keep element-index mappings across service worker restarts (session-only, never synced) |
| `nativeMessaging` (Chrome + Firefox) | Talk to the local native host when `browser-outo install-native` has been run; absent or unused in WebSocket-fallback mode |

## Data retention

The extension retains nothing. Console log buffers and element mappings are
held only in memory (or session-only storage) and disappear when the tab or
browser closes.

## Security model

**WebSocket transport.** When the local server starts, it writes a fresh
per-run bearer token into a per-user state directory:
`$XDG_RUNTIME_DIR` or `~/.local/state` on Linux,
`~/Library/Application Support/browser-outo` on macOS, and
`%LOCALAPPDATA%\browser-outo` on Windows. The directory is mode `0700`
and the `token-<port>` file is mode `0600`. The CLI reads the token
automatically; the WebSocket only accepts `chrome-extension://` and
`moz-extension://` origins, and the server refuses to bind a
non-loopback address unless explicitly told to.

**Native transport (optional, recommended).** Running
`browser-outo install-native` once per machine registers a small native
host with Chrome and Firefox. The browser then spawns the host itself
and the extension talks to it over stdio (no TCP port is opened), and
the CLI talks to the same host over a per-user Unix socket
(directory `0700`, socket `0600`, with peer-credential UID checks and a
per-browser token verified on the first frame).

**Honest floor.** A process running under the same user account can
read your token, replace the native host, or delete the manifests to
force a WebSocket fallback. This matches Chromium's own stance on
native messaging — there is no portable defense against a same-UID
local attacker. Downgrades are always visible: the extension logs its
active transport (`[outo] transport: native | websocket`) at every
connect, and `browser-outo extensions` includes a `transport` column
so the current path is observable from the CLI.

## Changes to this policy

Any changes will be published in the repository at
<https://github.com/llaa33219/browser-outo> with an updated effective date.

## Contact

Questions about privacy: open an issue at
<https://github.com/llaa33219/browser-outo/issues>.
