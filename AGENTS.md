# AGENTS.md

Guidance for AI coding agents working on this repo.

## What this is

`cache-bar` is a Claude Code mod (a function-hook plugin) that shows prompt cache status: TTL countdown, hit rate, hit-rate history, cache-break warnings and context size. It also warns before the cache expires and can keep it warm. The full UI is on the desktop Code tab; terminal and VS Code get a one-line status.

## Layout

```
.claude-plugin/marketplace.json   marketplace listing (repo = marketplace)
plugins/cache-bar/
  .claude-plugin/plugin.json      manifest, userConfig, types contract
  hooks/hooks.json                points at the hooks module
  hooks/register.tsx              the hooks module: register(on, options)
  types/index.d.ts                $.state contract
```

## Workflow

- Load the `plugin-authoring` skill before writing hooks code. Its `types/claude-code.d.ts` is the API reference for the running build.
- Validate after every change: `claude plugin validate plugins/cache-bar`.
- Test: `claude plugin test plugins/cache-bar` runs `plugins/cache-bar/tests/*.test.ts`. Pure logic lives in `hooks/core.ts` so tests call it directly.
- Preview live: point `CLAUDE_CODE_PLUGIN_DIRS` at `plugins/cache-bar` and set `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` (in the `env` block of `~/.claude/settings.json`), then open a new desktop session. Saved edits reload the module.
- Commit messages follow Conventional Commits (`type(scope): summary`). Don't add `Co-Authored-By` or other attribution trailers.

## API rules learned on desktop (Claude Code 2.1.286)

- Never pass `$` into your own helper functions; `claude plugin validate` rejects it. Write every `$.noun.method()` call inside a hook or a closure in one. Keep shared logic in pure functions over plain data.
- Redraw through `$.state`: write a value with `update($, atom, fn)` that the render hook `read`s. `$.ui.invalidate('ui.render')` called from a `$.clock.every` timer did not redraw the band.
- Hooks that fire in bursts (`tool.describe` runs once per tool, all at once) must not `update` one shared value: every retry loses to another writer and `update` throws after its bound. Key such data by a `StateFamily` member per id, or write with a plain `$.state.set`.
- `$.command.run` skips the calling plugin's own `command.run` hooks. A Button must run its action in `onPress`, not by running the plugin's own slash command.
- Desktop draws `Svg` (and `Box`, `Text`, `Button`, `Input`, `Select`, `Link`, `Code`, `Markdown`, `Client`), but not `Raster` or `Image`. SMIL animation works in plain image mode.
- `isInteractive` draws the `Svg` in a frame that paints white behind a light-scheme document. Put `:root{color-scheme:light dark}` and a transparent background in the SVG's `<style>` and the frame blends in. The frame takes the slot's width and doesn't scale the markup; give the root `<svg>` `width="100%" height="100%"` with a `viewBox` and `preserveAspectRatio`, and leave the element's `width` unset. Pure CSS `:hover` (and `:has`) works inside; scripts don't.
- Box offsets are whole character cells and a Pane hook only gets its width in cells (`e.props.bodyColumns`), so Boxes can't line up with an Svg's pixels. Do hover inside the SVG instead.
- `$.ui.toast` shows bottom right on desktop, and toast and status lines are already titled with the plugin name, so don't prefix the text.
- `$.audio.play` reports success on Windows but makes no sound, and `$.audio.speak` fails ("no speech synthesizer on windows"). Don't rely on audio.
- `$.model.fork({ prompt })` re-sends the main thread's last request. It reads the cached prefix (write 0), keeps its own tail out of the cache, and doesn't appear in the transcript. This is the keep-warm mechanism.
- The API doesn't expose the cache TTL (5m or 1h). Infer it: a cache hit after more than 5 minutes idle means 1h.
- In `claude plugin test`, a test's hooks stand for the engine: every `$` call the plugin makes needs one (`session.start`, `command.register`, `ui.status`, ...). Hooks for `$` methods answer `{ value }` (or `{ deny }`); event hooks answer the event's result. `mock.clock` drives `$.clock.every`.
- `claude plugin validate` reports a matcher built from an imported constant as `?`; it still matches at run time.
