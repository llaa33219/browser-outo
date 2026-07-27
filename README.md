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
- **Fully local.** A tiny server on `127.0.0.1:11681` bridges the CLI and the
  extension over WebSocket. No telemetry, no external calls.

## How it works

```
┌─────────────┐   HTTP    ┌──────────────────┐  WebSocket  ┌─────────────────┐
│ browser-outo│ ────────► │ local server     │ ◄────────── │ browser         │
│ CLI (agent) │           │ 127.0.0.1:11681  │  (outbound) │ extension       │
└─────────────┘           └──────────────────┘             └─────────────────┘
```

The extension connects **outbound** to the local server, so there's nothing
to open in your firewall and no pairing step. Multiple browsers can connect
at once — each gets a numeric `EXT_ID` you target per command.

## Install

Two pieces, all local:

**1. The agent skill** (teaches your AI agent how to drive it — the skill
also installs the CLI for you when needed):

```bash
npx skills add llaa33219/browser-outo
```

**2. The browser extension** — coming soon to the Chrome Web Store and
Firefox Add-ons.

Then just ask your agent to do things in your browser — open pages, fill
forms, read content, take screenshots. The agent handles every command
through the skill; you never have to learn a CLI.

It works inside iframes too — elements from all frames (CAPTCHA widgets
included) are merged into one numbered list, and clicks route to the right
frame automatically.

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
