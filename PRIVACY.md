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
extension is the bridge between your browser and the browser-outo server
that **you run yourself on your own computer** (`127.0.0.1:11681`, localhost).
It receives commands from that local server and executes them in your
browser: opening tabs, reading page content, clicking, typing, scrolling,
capturing screenshots, and similar actions.

## What data the extension accesses

To perform its function, the extension can access, **only when instructed by
you (through the local browser-outo server)**:

- The URLs and titles of your open tabs
- The content (HTML, text, console output) of pages you point it at
- Screenshots of tabs you point it at
- Input it performs on your behalf (clicks, keystrokes, form text)

## Where that data goes

**Only to `127.0.0.1` (your own computer).** The extension connects
exclusively to the browser-outo server running locally on your machine over
a WebSocket on port 11681. It does not connect to any external server,
cloud service, or third party. Everything the extension reads stays inside
your computer, under your control.

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

## Data retention

The extension retains nothing. Console log buffers and element mappings are
held only in memory (or session-only storage) and disappear when the tab or
browser closes.

## Changes to this policy

Any changes will be published in the repository at
<https://github.com/llaa33219/browser-outo> with an updated effective date.

## Contact

Questions about privacy: open an issue at
<https://github.com/llaa33219/browser-outo/issues>.
