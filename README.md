# claude-cache-bar

[繁體中文](README.zh-TW.md)

A Claude Code mod that shows what your prompt cache is doing: how long until it expires, how much each request read from it, when it broke and why. It warns you before the cache expires and can keep it warm for you.

A cache hit costs a tenth of the normal input price; a cache write costs 1.25× (5-minute TTL) or 2× (1-hour TTL). Step away for a few minutes too long and the next request pays to write the whole conversation again. cache-bar makes that visible.

## Install

```
/plugin marketplace add TheTsungYing/claude-cache-bar
/plugin install cache-bar@claude-cache-bar
```

Needs Claude Code 2.1.286 or later (function-hook plugins, an early-access API).

## What you get

**Desktop (Code tab)**: a compact, one-row band above the prompt. It stays quiet while the cache is fine and adds color only when something needs you.

- A small countdown ring and clock for the cache TTL. Grey while fresh, orange at 20% left, red at 10%, a dashed grey ring once expired. Nothing blinks.
- Hover over the band for the last request's hit rate, the context size and a hit-rate trend line (and, once expired, what the next request will rewrite).
- While Claude is answering, the ring holds still and the clock shows `…`: each request refreshes the cache.
- An **Extend** button when the cache is about to expire.
- A red ⚠ when the cache broke; hover over it for the likely cause.
- **Details** opens the side panel.
- Don't want the band at all? Set **Band above the prompt** to **Off** in the side panel; the toasts still warn you.

**Side panel** (`/cache` or **Details**):

- The countdown, with the TTL, last hit rate and context on one line.
- This conversation: average hit rate, requests, breaks, extensions, peak context.
- A per-request chart: stacked bars for cache read / write / miss, with writes (what costs) in orange, the hit-rate line, and red dots on breaks.
- The list of cache breaks with their likely causes, and the extensions made; one line when there are none.
- Quick settings for what happens near expiry, the TTL mode (with how it was detected) and the band.

**Terminal and VS Code**: one status line.

```
⚡ 3:42 · 94% · 48.2k
⚠ 0:28 /cache-extend · 94% · 48.2k
```

## Commands

| Command | What it does |
|---|---|
| `/cache` | Opens the side panel |
| `/cache-extend` | Keeps the cache warm now |

## Keeping the cache warm

Extending re-sends the main conversation's last request in the background through `$.model.fork`, followed by a one-word prompt. The request reads the whole cached prefix, which restarts the TTL. It never shows up in your conversation.

It costs about the context size at the cache-read price (0.1×) plus a few output tokens. A 50k context costs as much as about 5k fresh input tokens. Letting it expire instead costs a rewrite at 1.25× or 2×, so extending pays for itself up to roughly 12 times on a 5-minute cache and 20 on a 1-hour one.

With `onExpiring` set to `auto`, cache-bar extends on its own when the alert threshold is reached, within three limits: at most `autoExtendMaxPerIdle` times while you are away (default 3), only for a context of at least `autoExtendMinContextK` thousand tokens (default 20), and optionally not after `autoExtendGiveUpMin` minutes idle.

## How the TTL is detected

Claude Code doesn't tell plugins whether your cache lives 5 minutes or 1 hour, so the countdown is an estimate. With `ttlMode` on `auto`, cache-bar assumes 5 minutes (it would rather warn early). When a request sent after more than 5 minutes idle still reads most of its input from the cache, the TTL must be 1 hour, and cache-bar remembers that across sessions. If, later, a request inside the hour misses completely with nothing else to blame, it goes back to 5 minutes.

Set `ttlMode` to `5m` or `1h` if you know which one you have.

## Cache breaks

A request counts as a cache break when the context is large, its hit rate is low, and the previous request's was high. The thresholds depend on `breakSensitivity`:

| Sensitivity | Context over | This request under | Previous over |
|---|---|---|---|
| `low` | 20k | 30% | 85% |
| `medium` | 10k | 50% | 80% |
| `high` | 5k | 70% | 70% |

Likely causes: idle past the TTL, a model switch, a compaction, a change to the system prompt or CLAUDE.md, or a change to the tool list.

## Settings

Each one is a row in `/config`. The side panel's quick settings change `onExpiring`, `ttlMode` and `band` too.

| Setting | Values | Default | |
|---|---|---|---|
| `language` | `en`, `zh-TW` | `en` | Display language |
| `ttlMode` | `auto`, `5m`, `1h` | `auto` | Cache TTL |
| `onExpiring` | `notify`, `button`, `auto` | `button` | Notify only; notify and offer Extend; extend automatically |
| `band` | `compact`, `off` | `compact` | Desktop band above the prompt; `off` leaves only the toasts |
| `warnAtPercent` | 1–99 | 20 | Turn orange at this % of the TTL left |
| `alertAtPercent` | 1–99 | 10 | Notify (and offer Extend) at this % left |
| `toast` | on / off | on | Show a toast before the cache expires |
| `autoExtendMaxPerIdle` | 0–100 | 3 | Auto-extend at most this many times while you are away |
| `autoExtendMinContextK` | 0–10000 | 20 | Don't auto-extend a context smaller than this many thousand tokens |
| `autoExtendGiveUpMin` | 0–1440 | 0 | Stop auto-extending after this many minutes idle; 0 = no limit |
| `breakSensitivity` | `low`, `medium`, `high` | `medium` | How readily a drop counts as a break |

## Limits

- The TTL is inferred, not read; the countdown is an estimate.
- Only the main conversation is counted, not subagents.
- Notifications are in-app toasts only. Sound and speech aren't used: on Windows they don't work.
- A plugin can't switch your TTL to 1 hour.
- Extending costs tokens.

## Development

Load the plugin straight from disk:

```
claude --plugin-dir ./plugins/cache-bar
```

The desktop app takes no flag: set `CLAUDE_CODE_PLUGIN_DIRS` to the absolute path of `plugins/cache-bar` (and `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`) in the `env` block of `~/.claude/settings.json`, then open a new session. Saved edits reload the module.

Check and test it:

```
claude plugin validate ./plugins/cache-bar
claude plugin test ./plugins/cache-bar
```

For editor type-checking, run `/plugin-types plugins/cache-bar/.claude/types` inside Claude Code, then open `plugins/cache-bar` in your editor.

```
.claude-plugin/marketplace.json   marketplace listing
plugins/cache-bar/
  .claude-plugin/plugin.json      manifest and userConfig
  hooks/register.tsx              the hooks module
  hooks/core.ts                   pure logic: samples, TTL, breaks, keep-warm limits
  hooks/svg.ts                    the band's and panel's drawings
  hooks/i18n.ts                   English and Traditional Chinese strings
  types/index.d.ts                $.state contract
  tests/                          claude plugin test
```

## License

[MIT](LICENSE)
