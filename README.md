# claude-cache-bar

A Claude Code mod that shows the prompt cache status of the current session:
hit rate, tokens read from / written to the cache, and (planned) a TTL countdown.

> Status: early skeleton. UI and features are still being designed.

## Install

```
/plugin marketplace add TODO-github-name/claude-cache-bar
/plugin install cache-bar@claude-cache-bar
```

Requires a Claude Code build with function-hook plugins (developed on 2.1.286).

## Develop

Load the plugin straight from disk:

```
claude --plugin-dir ./plugins/cache-bar
```

Check it before publishing:

```
claude plugin validate ./plugins/cache-bar
```

For editor type-checking, run `/plugin-types plugins/cache-bar/.claude/types`
inside Claude Code, then open `plugins/cache-bar` in your editor.

## Layout

```
.claude-plugin/marketplace.json   marketplace listing
plugins/cache-bar/
  .claude-plugin/plugin.json      plugin manifest
  hooks/hooks.json                points at the hooks module
  hooks/register.tsx              the hooks module
  types/index.d.ts                $.state contract
```
