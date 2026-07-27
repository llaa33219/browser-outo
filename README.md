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

All four tools are local software — the honest differences are in defaults,
friction, and where your page data goes:

| | **browser-outo** | browser-use | Playwright MCP | Claude for Chrome |
|---|---|---|---|---|
| Real browser, your logins | ✅ the default — one extension, zero browser-side setup | ⚠️ possible: CDP attach (approve remote-debugging prompt) or real profile (must fully quit Chrome first) | ⚠️ possible: `--cdp-endpoint` attach or persistent profile | ✅ the default |
| Keeps working while you browse | ✅ your browser stays 100% usable | ❌ real-profile mode locks Chrome out | ❌ same lock issue | ✅ |
| "Being debugged" infobar | ✅ never (no debugger API) | ✅ none | ✅ none | ❌ shows (uses chrome.debugger) |
| Page data leaves machine | **never** — localhost only | → whatever LLM you configure | → your MCP client's LLM | → Anthropic API (screenshots/content) + usage data |
| Agent freedom | any CLI-capable agent (SKILL.md included) | its own agent loop (needs an LLM — cloud or local) | any MCP-capable client | Claude only, paid plan |
| Browsers | Chrome **and** Firefox, simultaneously | Chromium-family | Chromium-family for real-browser attach | Chrome only |
| Cost | free, Apache-2.0 | free + LLM costs | free + LLM costs | paid subscription required |

The short version: browser-use and Playwright can reach a real browser, but
only through CDP ceremony or by kicking you out of your own profile.
Claude for Chrome is the closest in spirit, but it ships your page content
to Anthropic, flashes a debugging banner, and only works with a paid Claude
plan. browser-outo is a plain CLI against the browser you're already using —
no fingerprint, no banner, no cloud, no lock-in.

## For AI agents

The skill source lives in `skills/browser-outo/SKILL.md` (installed via
`npx skills add llaa33219/browser-outo`). It teaches the agent the full
command set, the elements→interact loop, the annotate→vision loop, and the
pitfalls (stale indices, restricted pages, trusted-event sites).

## License

Apache-2.0
