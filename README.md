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

| | **browser-outo** | browser-use | Playwright (MCP) | Anthropic Chrome MCP |
|---|---|---|---|---|
| Uses **your** browser + logins | ✅ | ❌ (fresh cloud/local profile) | ❌ (fresh profile) | ✅ |
| Fully local, no external calls | ✅ | ❌ (LLM API in the loop) | ✅ | ✅ |
| CAPTCHA on a real profile | ✅ passes as you | ❌ flagged as bot | ❌ flagged as bot | ✅ |
| `navigator.webdriver` hidden | ✅ | ⚠️ patchable | ⚠️ patchable | ✅ |
| Setup | one extension + `npx skills add` | Python env + LLM key + browser | Node + browser download | extension + MCP config |
| Agent integration | any CLI-capable agent (SKILL.md included) | its own agent loop | MCP servers | Claude only |
| Multi-browser at once | ✅ Chrome + Firefox simultaneously | ❌ | ❌ | ❌ |

browser-use and Playwright drive a **separate, automation-controlled
browser** — sites see a fresh profile with an automation fingerprint and no
history, which is exactly what CAPTCHAs and bot-walls punish. The Anthropic
Chrome MCP shares the "your real browser" idea but only works with Claude
via MCP. browser-outo is a plain CLI: any agent or script that can run shell
commands can use it, against the browser you already trust.

## For AI agents

The skill source lives in `skills/browser-outo/SKILL.md` (installed via
`npx skills add llaa33219/browser-outo`). It teaches the agent the full
command set, the elements→interact loop, the annotate→vision loop, and the
pitfalls (stale indices, restricted pages, trusted-event sites).

## License

Apache-2.0
