<p align="center">
  <img src="logo.svg" alt="browser-outo logo" width="800">
</p>

# browser-outo

**Let AI agents drive YOUR real browser — the one you're already logged into.**

browser-outo is a CLI + browser extension that gives AI agents (Claude Code,
OpenCode, or any script) full control over your actual Chrome or Firefox:
open tabs, read pages, click, type, scroll, screenshot, and more. Everything
runs **100% locally** — your cookies, sessions, and credentials never leave
your machine.

- **No cloud browser, no fresh profile.** The agent uses *your* browser with
  *your* logins, *your* cookies, *your* reputation. Sites that bot-drive
  browsers can't touch (CAPTCHAs, login walls, Cloudflare) just work —
  reCAPTCHA v2 passes with a single click on a well-used profile.
- **No automation fingerprint.** Nothing is injected into the page before you
  say so, and there's no `navigator.webdriver` flag. Commands run through a
  normal browser extension, not an automation driver.
- **Fully local.** The CLI uses token-authenticated HTTP to a local server on
  `127.0.0.1:11681`, and the browser extension connects to that server over
  WebSocket. No telemetry, no external calls.

## How it works

```
┌─────────────┐  HTTP + token  ┌──────────────────┐  WebSocket  ┌─────────────────┐
│ browser-outo│ ◄────────────► │ local server     │ ◄─────────► │ browser         │
│ CLI (agent) │                │ 127.0.0.1:11681  │  (outbound) │ extension       │
└─────────────┘                └──────────────────┘             └─────────────────┘
```

Run `browser-outo serve` to start the local server. The CLI sends commands to
it over HTTP with a bearer token, and the extension opens an outbound
WebSocket connection to it. Multiple browsers can connect at once, and each
gets a numeric `EXT_ID` you target per command.

## Security and limitations

Each server start creates a fresh bearer token in a per-user state directory.
The directory is mode `0700`, and the token file is mode `0600`. API requests
require the token, the WebSocket accepts only extension origins, and the server
stays on loopback unless you pass `--allow-remote`.

A process running as the same user can kill the server, bind to its loopback
port, and impersonate browser-outo to an extension that connects afterward.
This is a known, accepted limitation of the local WebSocket architecture.

## Install

**1. The agent skill** (teaches your AI agent how to drive it and installs the
CLI when needed):

```bash
npx skills add llaa33219/browser-outo
```

**2. The browser extension** is coming soon to the Chrome Web Store and
Firefox Add-ons.

**3. Start the local server:**

```bash
browser-outo serve
```

The server listens on `127.0.0.1:11681`. Leave it running while browser-outo
is in use. The extension connects automatically, though its retry loop means
the first connection after a restart can take a few seconds.

Then ask your agent to open pages, fill forms, read content, or take
screenshots. The agent handles every command through the skill.

It works inside iframes too. Elements from all frames are merged into one
numbered list, and clicks route to the right frame automatically.


## Why not browser-use / Playwright / Chrome MCP?

All four tools are local software with CLI/skill-based agent interfaces —
the honest differences are what browser you end up driving, and where your
page data goes:

| | **browser-outo** | browser-use | Playwright (CLI/MCP) | Claude for Chrome |
|---|---|---|---|---|
| **Your live browser session** (same profile, same tabs, while you keep browsing) | ✅ the default — one extension, zero browser-side setup | ❌ since **Chrome 136** CDP is blocked on your real profile — you must automate a *copied* profile and log in again there | ❌ same Chrome 136 block; otherwise launches its own Chromium/Firefox/WebKit build, not your browser | ✅ |
| "Being debugged" infobar | ✅ never (no debugger API) | ✅ none | ✅ none | ❌ shows (uses chrome.debugger) |
| Page data leaves machine | **never** — localhost only | → whatever LLM you configure | → your MCP client's LLM | → Anthropic API (screenshots/content) + usage data |
| Agent interface | any CLI-capable agent (SKILL.md included) | CLI + skills, or its own LLM agent loop | playwright-cli + skills, or MCP server | Claude only |
| Browsers | Chrome **and** Firefox, simultaneously | Chromium (CDP) | launches Chromium/Firefox/WebKit; attaching to your *existing* browser is Chromium-only | Chrome only |
| Cost | free, Apache-2.0 | free, open source | free, open source | **paid Claude plan required** |

(LLM costs for the driving agent apply equally to all four — the only
mandatory extra is Claude for Chrome's subscription.)

The short version: since Chrome 136 killed remote debugging on real
profiles, CDP-based tools can only drive a *copy* of your browser — a
separate profile that drifts out of sync with your daily one. Claude for
Chrome is the closest in spirit, but it ships your page content to
Anthropic, flashes a debugging banner, and requires a paid plan.
browser-outo drives the browser you're literally using right now, from any
agent — no fingerprint, no banner, no profile copies, no lock-in.

## For AI agents

The skill source lives in `skills/browser-outo/SKILL.md` (installed via
`npx skills add llaa33219/browser-outo`). It teaches the agent the full
command set, the elements→interact loop, the annotate→vision loop, and the
pitfalls (stale indices, restricted pages, trusted-event sites).

## License

Apache-2.0
