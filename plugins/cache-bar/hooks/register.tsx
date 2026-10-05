import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CacheBreak, CacheSample, Extension, Overrides } from '../types'
import {
  EMPTY_TTL,
  EXTEND_COMMAND,
  KEEP_WARM_PROMPT,
  LANGUAGES,
  MAX_EVENTS,
  MAX_SAMPLES,
  NARROW_COLUMNS,
  NO_OVERRIDES,
  anchorOf,
  appendCapped,
  applyOverrides,
  chartModel,
  contextOf,
  countdownOf,
  effectiveTtl,
  formatCauses,
  formatClock,
  formatPercent,
  formatStatus,
  formatTokens,
  guessCauses,
  hitRateOf,
  isBreak,
  isTtlState,
  learnTtl,
  legendMarks,
  normalizeOverrides,
  notePrint,
  parseCacheArgs,
  readConfig,
  readoutOf,
  recentHits,
  shouldAutoExtend,
  summarize,
  toBreak,
  toExtension,
  toSample,
  withOverride,
  withoutOverride,
} from './core'
import type { QuickSetting } from './core'
import { LANGUAGE_NAMES, STRINGS } from './i18n'
import {
  BIG_CLOCK_SIZE,
  BIG_RING_SIZE,
  CHART_BARS,
  CLOCK_SIZE,
  COLORS,
  NARROW_CHART_BARS,
  RING_SIZE,
  SPARK_HEIGHT,
  SPARK_WIDTH,
  chartSvg,
  clockSvg,
  idleRingSvg,
  pausedRingSvg,
  ringSvg,
  sparklineSvg,
} from './svg'

const samples = atom({ plugin: 'cache-bar', key: 'samples' } as const, [] as CacheSample[])
const breaks = atom({ plugin: 'cache-bar', key: 'breaks' } as const, [] as CacheBreak[])
const extensions = atom({ plugin: 'cache-bar', key: 'extensions' } as const, [] as Extension[])
const ttl = atom({ plugin: 'cache-bar', key: 'ttl' } as const, EMPTY_TTL)
// Families, one member per id: many hooks fire at once (tool.describe once per
// tool), and members never contend the way one shared value would.
const changedAt = { plugin: 'cache-bar', key: 'changedAt' } as const
const prints = { plugin: 'cache-bar', key: 'prints' } as const
const clock = atom({ plugin: 'cache-bar', key: 'now' } as const, 0)
const stage = atom({ plugin: 'cache-bar', key: 'stage' } as const, 'none')
const extending = atom({ plugin: 'cache-bar', key: 'extending' } as const, false)
const overrides = atom({ plugin: 'cache-bar', key: 'overrides' } as const, NO_OVERRIDES)
const alertedFor = atom({ plugin: 'cache-bar', key: 'alertedFor' } as const, null as number | null)

/** `$.store` key of the learned TTL, kept across sessions. */
const TTL_STORE_KEY = 'ttl'

/** `$.store` key of the settings picked in the panel. */
const OVERRIDES_STORE_KEY = 'overrides'

/** Requests the band's trend line spans. */
const SPARK_POINTS = 24

/** The side panel's id, and the command that opens it. */
const PANE = 'cache-bar'
const COMMAND = 'cache'

/** Rows the panel's break and extension lists show, newest first. */
const LIST_ROWS = 8

/** Text that needs you: the theme's error colour, so it follows light and dark. */
const TEXT_ALERT = 'error'

export const register: Register = (on, options) => {
  // The userConfig values, and those in force once the panel's picks apply.
  const base = readConfig(options)
  let config = base
  let strings = STRINGS[config.language]
  // `$.state` outlives a reload, so it may hold picks saved in an older shape.
  const applyPicks = (picked: Overrides) => {
    config = applyOverrides(base, normalizeOverrides(picked) ?? NO_OVERRIDES)
    strings = STRINGS[config.language]
  }
  let shownStatus: string | undefined
  // Once the desktop band draws, the status line would only repeat it.
  let hasBand = false
  let isWorking = false
  let isForking = false
  // Set by session.start: one keep-warm fork, resolving to what it reports
  // (null when one is already running), toasted unless `shouldToast` is false.
  // The buttons call it too, since a Button can't reach this plugin's own
  // slash command.
  let extendNow: ((trigger: Extension['trigger'], shouldToast?: boolean) => Promise<string | null>) | null = null
  // Set by session.start: applies a setting picked in the panel or with
  // `/cache lang`, resolving to why it failed, or null once it is done.
  let pickOption: ((field: QuickSetting, value: string) => Promise<string | null>) | null = null
  // The ring's drawing stays the same while its anchor, TTL and phase do, so
  // its SMIL countdown keeps running across the band's redraws.
  let ring = { key: '', source: '' }
  let smallClock = { key: '', source: '', width: 0, height: 0 }
  // The panel's ring and clock, kept the same way. Dropped when the panel
  // opens or closes: a fresh drawing restarts its SMIL from load.
  let bigRing = { key: '', source: '' }
  let bigClock = { key: '', source: '', width: 0, height: 0 }
  const forgetPaneDrawings = () => {
    bigRing = { key: '', source: '' }
    bigClock = { key: '', source: '', width: 0, height: 0 }
  }

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(TTL_STORE_KEY)

    if (isTtlState(stored)) {
      await update($, ttl, current => (current.detected === null ? stored : current))
    }

    const storedOverrides = normalizeOverrides(await $.store.get(OVERRIDES_STORE_KEY))

    if (storedOverrides !== null) {
      await update($, overrides, () => storedOverrides)
    }

    applyPicks(await read($, overrides))
    await $.command.register({ name: COMMAND, description: strings.commandDescription })
    await $.command.register({ name: EXTEND_COMMAND, description: strings.extendCommandDescription })

    // A reload after a language change keeps the panel up under its old title.
    const shownPane = (await $.ui.panes()).find(pane => pane.id === PANE)

    if (shownPane !== undefined && shownPane.title !== strings.paneTitle) {
      await $.ui.open({ id: PANE, title: strings.paneTitle })
    }

    extendNow = async (trigger, shouldToast = true) => {
      if (isForking) {
        return null
      }

      isForking = true
      await update($, extending, () => true)
      const sentAt = await $.clock.now()

      try {
        const outcome = await $.model.fork({ prompt: KEEP_WARM_PROMPT })
        const extension = toExtension(outcome, sentAt, trigger)
        await update($, extensions, list => appendCapped(list, extension, MAX_EVENTS))
        const readK = formatTokens(extension.read)
        const text = !outcome.isAnswered
          ? strings.extendFailed(outcome.reason)
          : trigger === 'manual'
            ? strings.extended(readK)
            : strings.autoExtended(readK)

        // A quiet auto extension stays quiet; a failure is always told.
        if (shouldToast && (trigger === 'manual' || config.toast || !outcome.isAnswered)) {
          $.ui.toast(text)
        }

        return text
      } catch (err) {
        const reason = String(err)
        const extension = toExtension({ isAnswered: false, reason }, sentAt, trigger)
        await update($, extensions, list => appendCapped(list, extension, MAX_EVENTS))
        const text = strings.extendFailed(reason)

        if (shouldToast) {
          $.ui.toast(text)
        }

        return text
      } finally {
        isForking = false
        await update($, extending, () => false)
      }
    }

    // Through `/config` where it has the row: the module reloads with the new
    // options. A plugin folder on desktop gets no rows, so the pick is kept as
    // an override instead, in `$.state` (redrawing) and `$.store`.
    pickOption = async (field, value) => {
      if (value === config[field]) {
        return null
      }

      try {
        const rows = await $.config.list()
        const row =
          rows.find(r => r.key === `cache-bar.${field}`) ??
          rows.find(r => r.key.startsWith('cache-bar') && r.key.endsWith(`.${field}`))

        if (row === undefined) {
          await update($, overrides, o => withOverride(normalizeOverrides(o) ?? NO_OVERRIDES, base, field, value))
        } else {
          const result = await $.config.set({ key: row.key, value })

          if (result.deny !== undefined) {
            return strings.settingFailed(result.deny)
          }

          // An override kept from before the row existed would still win over
          // it while the value it replaced stands, so the row's pick drops it.
          await update($, overrides, o => withoutOverride(normalizeOverrides(o) ?? NO_OVERRIDES, field))
        }

        const picked = await read($, overrides)
        applyPicks(picked)
        await $.store.set(OVERRIDES_STORE_KEY, picked)

        if (field === 'language' && (await $.ui.panes()).some(pane => pane.id === PANE)) {
          await $.ui.open({ id: PANE, title: strings.paneTitle })
        }

        // Once the panel closes, nothing on screen leads back: say how.
        if (field === 'band' && value === 'off') {
          $.ui.toast(strings.bandTurnedOff(COMMAND))
        }

        return null
      } catch (err) {
        return strings.settingFailed(String(err))
      }
    }

    // The clock goes through $.state: a value the drawings read redraws them.
    $.clock.every(1000, async () => {
      const now = await $.clock.now()
      await update($, clock, () => now)

      const view = {
        samples: await read($, samples),
        breaks: await read($, breaks),
        extensions: await read($, extensions),
        ttl: await read($, ttl),
        config,
        isWorking,
        isExtending: isForking,
        now,
      }
      // The terminal and VS Code have no band: the status line is their display.
      const text = hasBand ? undefined : formatStatus(view, strings)

      if (text !== shownStatus) {
        shownStatus = text
        $.ui.status(text)
      }

      // Expiry notices: none while Claude answers, since each request refreshes.
      const last = view.samples.at(-1)
      const countdown = countdownOf(view.samples, view.extensions, config.ttlMode, view.ttl, config, now)
      const nextStage = isWorking
        ? 'working'
        : countdown === null
          ? 'none'
          : `${countdown.anchor}|${countdown.ttl}|${countdown.phase}`

      if ((await read($, stage)) !== nextStage) {
        await update($, stage, () => nextStage)
      }

      if (isWorking || last === undefined || countdown === null || countdown.phase !== 'alert') {
        return
      }

      if (shouldAutoExtend({ samples: view.samples, extensions: view.extensions, countdown, config, now })) {
        void extendNow?.('auto')

        return
      }

      if ((await read($, alertedFor)) === last.sentAt) {
        return
      }

      await update($, alertedFor, () => last.sentAt)

      if (config.toast) {
        const notice = strings.expiresIn(formatClock(countdown.leftMs))
        const isBandOff = hasBand && config.band === 'off'
        const hint = hasBand && !isBandOff ? strings.pressExtend : strings.runExtend(EXTEND_COMMAND)
        // With the band off, nothing on screen leads to the panel: the toast does.
        const panel = isBandOff ? ` · ${strings.openPanel(COMMAND)}` : ''
        $.ui.toast(`${config.onExpiring === 'notify' ? notice : `${notice} · ${hint}`}${panel}`)
      }
    })

    return next(e)
  })

  // `/cache` opens the panel; `/cache lang [en|zh-TW]` switches the language,
  // to the other one when none is named.
  on('command.run', { command: COMMAND }, async ($, e) => {
    const asked = parseCacheArgs(e.args, config.language)

    if (asked.kind === 'unknown') {
      return { text: strings.cacheUsage(COMMAND) }
    }

    if (asked.kind === 'language') {
      const failed = await pickOption?.('language', asked.language)

      return { text: failed ?? STRINGS[asked.language].languageSet(LANGUAGE_NAMES[asked.language]) }
    }

    forgetPaneDrawings()
    const opened = await $.ui.open({ id: PANE, title: strings.paneTitle })

    return opened.isPlaced ? {} : { text: strings.paneUnplaced(opened.reason) }
  })

  // Keeps the cache warm now, whatever the countdown says: the TTL is only an
  // estimate. The answer is the command's output line rather than a toast.
  on('command.run', { command: EXTEND_COMMAND }, async $ => {
    if ((await read($, samples)).length === 0) {
      return { text: strings.extendNothing }
    }

    if (isWorking) {
      return { text: strings.extendBusy }
    }

    const text = await extendNow?.('manual', false)

    return { text: text ?? strings.extendAlready }
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isWorking = false

    return next(e)
  })

  // Record each main-thread request's cache usage; judge breaks and the TTL.
  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const step = yield* next(e)

    // Outside a turn while a keep-warm fork runs, the request is the fork's own:
    // counting it would start a new idle stretch and lift the auto-extend cap.
    if (e.agentId !== undefined || step.usage === null || (isForking && !isWorking)) {
      return step
    }

    const at = await $.clock.now()
    const previous = (await read($, samples)).at(-1)
    const sample = toSample(step.usage, sentAt, at, previous)

    if (previous !== undefined) {
      const learned = await read($, ttl)
      const marks = {
        compactAt: (await read($, { ...changedAt, id: 'compact' })) ?? null,
        systemAt: (await read($, { ...changedAt, id: 'system' })) ?? null,
        toolsAt: (await read($, { ...changedAt, id: 'tools' })) ?? null,
      }
      // A keep-warm fork refreshed the cache too: idle counts from the later of
      // the two, or a kept-warm 5m cache would read as proof of 1h.
      const forks = (await read($, extensions)).filter(x => x.at < sentAt)
      const refreshedAt = anchorOf([previous], forks) ?? previous.sentAt
      const sinceRefresh = { ...sample, idleMs: sentAt - refreshedAt }
      const causes = guessCauses(previous, sinceRefresh, marks, effectiveTtl(config.ttlMode, learned))

      if (isBreak(previous, sample, config.breakSensitivity)) {
        await update($, breaks, list => appendCapped(list, toBreak(previous, sample, causes), MAX_EVENTS))
      }

      const relearned = learnTtl(learned, previous, sinceRefresh, causes.filter(c => c !== 'idle'))

      if (relearned !== learned) {
        await update($, ttl, () => relearned)
        await $.store.set(TTL_STORE_KEY, relearned)
      }
    }

    await update($, samples, list => appendCapped(list, sample, MAX_SAMPLES))

    return step
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    // `precompute` only prepares a summary; the conversation is unchanged.
    if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in result)) {
      await $.state.set({ ...changedAt, id: 'compact' }, await $.clock.now())
    }

    return result
  })

  // The next three only watch what the prompt is built from. A change seen
  // once the conversation has started is a likely cause of a cache break.
  // Marks are plain writes: concurrent ones all write about the same time.

  on('prompt.section', async ($, e, next) => {
    const result = await next(e)
    let isChange = false
    await update($, { ...prints, id: `section:${e.name}` }, seen => {
      const noted = notePrint(seen ?? [], result.text ?? '')
      isChange = noted.isChange

      return noted.seen
    })

    if (isChange && (await read($, samples)).length > 0) {
      await $.state.set({ ...changedAt, id: 'system' }, await $.clock.now())
    }

    return result
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    let isChange = false

    for (const block of result.blocks) {
      await update($, { ...prints, id: `context:${block.name}` }, seen => {
        const noted = notePrint(seen ?? [], block.text)
        isChange ||= noted.isChange

        return noted.seen
      })
    }

    if (isChange && (await read($, samples)).length > 0) {
      await $.state.set({ ...changedAt, id: 'system' }, await $.clock.now())
    }

    return result
  })

  on('tool.describe', async ($, e, next) => {
    const result = await next(e)
    let isChange = false
    await update($, { ...prints, id: `tool:${e.tool}` }, seen => {
      const noted = notePrint(seen ?? [], `${result.description}\u0000${String(result.isDeferred)}`)
      isChange = noted.isChange

      return noted.seen
    })

    if (isChange && (await read($, samples)).length > 0) {
      await $.state.set({ ...changedAt, id: 'tools' }, await $.clock.now())
    }

    return result
  })

  // The band above the prompt, desktop only, kept to one quiet row: ring,
  // clock and Details. Hit rate, context and the trend line show on hover;
  // a break mark and the extend button appear only when they need you.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) {
      return next(e)
    }

    // Set even when the band is off: the desktop keeps no status line then.
    hasBand = true
    // Redraw on the stage, not every second: the ring and the clock count down
    // by SMIL, and a per-second redraw of the band resets an open Select's
    // highlight in the panel too.
    await read($, stage)
    applyPicks(await read($, overrides))

    if (config.band === 'off') {
      return next(e)
    }

    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const now = await $.clock.now()
    const list = await read($, samples)
    const last = list.at(-1)
    const s = strings
    const details = (
      <Button
        key="details"
        plain
        dimColor
        label={s.details}
        onPress={() => {
          forgetPaneDrawings()
          void $.ui.open({ id: PANE, title: s.paneTitle })
        }}
      />
    )

    if (last === undefined) {
      return (
        <Box key="band" flexDirection="row" alignItems="center" gap={1}>
          <Svg key="ring" alt={s.ringAlt} source={idleRingSvg()} width={RING_SIZE} height={RING_SIZE} />
          {details}
          <Box display="none" hover={{ display: 'flex' }}>
            <Text dimColor>{s.waiting}</Text>
          </Box>
        </Box>
      )
    }

    const breakList = await read($, breaks)
    const countdown = countdownOf(list, await read($, extensions), config.ttlMode, await read($, ttl), config, now)
    const isExtending = await read($, extending)

    if (countdown === null) {
      return next(e)
    }

    const context = formatTokens(contextOf(last))
    const isAnswering = e.props.isWorking
    const ringKey = isAnswering ? 'working' : `${countdown.anchor}|${countdown.ttl}|${countdown.phase}`

    if (ring.key !== ringKey) {
      ring = { key: ringKey, source: isAnswering ? pausedRingSvg() : ringSvg(countdown) }
    }

    const lastBreak = breakList.at(-1)
    const didBreak = lastBreak !== undefined && lastBreak.at === last.sentAt
    const isExpired = !isAnswering && countdown.phase === 'expired'
    const canExtend = !isAnswering && countdown.phase === 'alert' && config.onExpiring !== 'notify'
    const clockColor =
      countdown.phase === 'warn' ? COLORS.warn : countdown.phase === 'alert' ? COLORS.alert : COLORS.neutral

    if (smallClock.key !== ringKey) {
      smallClock = { key: ringKey, ...clockSvg(countdown.leftMs, clockColor, CLOCK_SIZE) }
    }

    return (
      <Box key="band" flexDirection="row" alignItems="center" gap={1}>
        <Svg key="ring" alt={s.ringAlt} source={ring.source} width={RING_SIZE} height={RING_SIZE} />
        {/* Answering: the countdown waits, since each request refreshes the cache. */}
        {isAnswering ? (
          <Text dimColor>…</Text>
        ) : isExpired ? null : (
          <Svg
            key="clock"
            alt={formatClock(countdown.leftMs)}
            source={smallClock.source}
            width={smallClock.width}
            height={smallClock.height}
          />
        )}
        {isExtending ? (
          <Text dimColor>{s.extending}</Text>
        ) : canExtend ? (
          <Button key="extend" variant="primary" label={s.extendShort} onPress={() => void extendNow?.('manual')} />
        ) : null}
        {details}
        {didBreak ? (
          <Box key="break" flexDirection="row" gap={1}>
            <Text color={TEXT_ALERT}>⚠</Text>
            <Box display="none" hover={{ display: 'flex' }}>
              <Text color={TEXT_ALERT}>{s.broke(formatCauses(lastBreak.causes, s))}</Text>
            </Box>
          </Box>
        ) : null}
        {/* Shown while the pointer is over the band; after the buttons, so it never moves them. */}
        <Box display="none" hover={{ display: 'flex' }} flexDirection="row" alignItems="center" gap={1}>
          {isExpired ? (
            <Text dimColor>
              {s.expired} · {s.rewriteNext(context)}
            </Text>
          ) : null}
          <Text>
            <Text dimColor>{s.hit} </Text>
            {formatPercent(hitRateOf(last))}
          </Text>
          <Text>
            <Text dimColor>{s.context} </Text>
            {context}
          </Text>
          {list.length > 1 ? (
            <Svg
              key="spark"
              alt={s.sparkAlt}
              source={sparklineSvg(recentHits(list, breakList, SPARK_POINTS))}
              width={SPARK_WIDTH}
              height={SPARK_HEIGHT}
            />
          ) : null}
        </Box>
      </Box>
    )
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      forgetPaneDrawings()
    }

    return next(e)
  })

  // The side panel: the countdown large, this conversation's totals, the
  // per-request chart, breaks, extensions and quick settings. Drawings where
  // the surface has Svg; the terminal gets the text.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const Select = 'Select' in ui ? ui.Select : null
    // Redraw on the stage, not every second: the ring and clock count down by
    // SMIL. Without Svg (the terminal) the clock is text, so it reads `now`.
    await read($, stage)
    applyPicks(await read($, overrides))
    const s = strings

    if (Svg === null) {
      await read($, clock)
    }

    const now = await $.clock.now()
    const list = await read($, samples)
    const breakList = await read($, breaks)
    const extensionList = await read($, extensions)
    const learned = await read($, ttl)
    const isExtending = await read($, extending)
    const last = list.at(-1)
    const countdown = countdownOf(list, extensionList, config.ttlMode, learned, config, now)

    const setOption = async (field: QuickSetting, value: string) => {
      const failed = await pickOption?.(field, value)

      if (failed !== null && failed !== undefined) {
        $.ui.toast(failed)
      }
    }

    // How the TTL was settled; it explains the TTL setting, so it sits there.
    const ttlNote =
      config.ttlMode !== 'auto'
        ? null
        : learned.detected === '1h' && learned.idleMs !== null
          ? s.ttlLearned('1h', Math.floor(learned.idleMs / 60_000))
          : s.ttlAssumed
    const title = (text: string) => <Text bold>{text}</Text>
    const stat = (label: string, value: string) => (
      <Text>
        <Text dimColor>{label} </Text>
        {value}
      </Text>
    )

    const settings = (
      <Box flexDirection="column">
        {title(s.settingsTitle)}
        {Select === null ? (
          <Text dimColor>
            {s.onExpiringLabel}: {s.onExpiringOptions[config.onExpiring]} · {s.ttlModeLabel}:{' '}
            {s.ttlModeOptions[config.ttlMode]} · {s.bandLabel}: {s.bandOptions[config.band]} · {s.languageLabel}:{' '}
            {LANGUAGE_NAMES[config.language]}
            {ttlNote === null ? '' : `\n${ttlNote}`}
          </Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text dimColor>{s.onExpiringLabel}</Text>
              <Select
                key="onExpiring"
                value={config.onExpiring}
                options={(['notify', 'button', 'auto'] as const).map(v => ({ value: v, label: s.onExpiringOptions[v] }))}
                onSelect={value => void setOption('onExpiring', value)}
              />
            </Box>
            <Box flexDirection="column">
              <Text dimColor>{s.ttlModeLabel}</Text>
              <Select
                key="ttlMode"
                value={config.ttlMode}
                options={(['auto', '5m', '1h'] as const).map(v => ({ value: v, label: s.ttlModeOptions[v] }))}
                onSelect={value => void setOption('ttlMode', value)}
              />
              {ttlNote === null ? null : <Text dimColor>{ttlNote}</Text>}
            </Box>
            <Box flexDirection="column">
              <Text dimColor>{s.bandLabel}</Text>
              <Select
                key="band"
                value={config.band}
                options={(['compact', 'off'] as const).map(v => ({ value: v, label: s.bandOptions[v] }))}
                onSelect={value => void setOption('band', value)}
              />
            </Box>
            <Box flexDirection="column">
              <Text dimColor>{s.languageLabel}</Text>
              <Select
                key="language"
                value={config.language}
                options={LANGUAGES.map(v => ({ value: v, label: LANGUAGE_NAMES[v] }))}
                onSelect={value => void setOption('language', value)}
              />
            </Box>
          </Box>
        )}
      </Box>
    )

    if (last === undefined || countdown === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" alignItems="center" gap={2}>
            {Svg === null ? null : (
              <Svg
                key="ring"
                alt={s.ringAlt}
                source={idleRingSvg(BIG_RING_SIZE)}
                width={BIG_RING_SIZE}
                height={BIG_RING_SIZE}
              />
            )}
            <Text dimColor>{s.waiting}</Text>
          </Box>
          {settings}
        </Box>
      )
    }

    const context = formatTokens(contextOf(last))
    const ringKey = isWorking ? 'working' : `${countdown.anchor}|${countdown.ttl}|${countdown.phase}`

    if (bigRing.key !== ringKey) {
      bigRing = { key: ringKey, source: isWorking ? pausedRingSvg(BIG_RING_SIZE) : ringSvg(countdown, BIG_RING_SIZE) }
    }

    const clockColor =
      countdown.phase === 'warn' ? COLORS.warn : countdown.phase === 'alert' ? COLORS.alert : undefined

    if (bigClock.key !== ringKey) {
      bigClock = { key: ringKey, ...clockSvg(countdown.leftMs, clockColor ?? COLORS.neutral, BIG_CLOCK_SIZE) }
    }

    const canExtend = !isWorking && countdown.phase === 'alert' && config.onExpiring !== 'notify'
    const summary = summarize(list, breakList, extensionList)
    // A narrow panel gets fewer, wider bars and a three-line readout. Its
    // width comes in cells; ~8.7px each on desktop, a guess only for spacing.
    const isNarrow = e.props.bodyColumns < NARROW_COLUMNS
    const chart = chartModel(
      list,
      breakList,
      extensionList,
      config.ttlMode,
      learned,
      isNarrow ? NARROW_CHART_BARS : CHART_BARS,
      config.warnAtPercent,
    )
    const chartFirst = chart.bars[0]?.number ?? 0
    const chartMarks = legendMarks(chart)
    const chartDrawing = chartSvg(
      chart,
      `${chart.isCapped ? '≤ ' : ''}${formatTokens(Math.round(chart.top))}`,
      s.chartRange(chartFirst, chartFirst + chart.bars.length - 1),
      chart.bars.map(bar => readoutOf(bar, s, isNarrow)),
      e.props.bodyColumns * 8.7,
    )
    // The request an extension kept warm: the last one sent before it.
    const idleSince = (at: number) => [...list].reverse().find(x => x.sentAt < at)?.sentAt ?? null
    const numberOf = (sentAt: number) => {
      const i = list.findIndex(x => x.sentAt === sentAt)

      return i < 0 ? null : i + 1
    }
    const swatch = (color: string, glyph: string, label: string) => (
      <Text>
        <Text color={color}>{glyph}</Text>
        <Text dimColor> {label}</Text>
      </Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={2}>
          {Svg === null ? null : (
            <Svg key="ring" alt={s.ringAlt} source={bigRing.source} width={BIG_RING_SIZE} height={BIG_RING_SIZE} />
          )}
          <Box flexDirection="column">
            {isWorking ? (
              <Text dimColor>{s.working}</Text>
            ) : countdown.phase === 'expired' ? (
              <Text dimColor>
                {s.expired} · {s.rewriteNext(context)}
              </Text>
            ) : Svg === null ? (
              <Text bold color={clockColor}>
                {formatClock(countdown.leftMs)}
              </Text>
            ) : (
              <Svg
                key="clock"
                alt={formatClock(countdown.leftMs)}
                source={bigClock.source}
                width={bigClock.width}
                height={bigClock.height}
              />
            )}
            <Text dimColor>
              TTL {s.ttl(config.ttlMode, countdown.ttl)} · {s.lastHit} {formatPercent(hitRateOf(last))} · {s.context}{' '}
              {context}
            </Text>
          </Box>
          {isExtending ? (
            <Text dimColor>{s.extending}</Text>
          ) : canExtend ? (
            <Button
              key="extend"
              variant="primary"
              label={s.extend(context)}
              onPress={() => void extendNow?.('manual')}
            />
          ) : null}
        </Box>

        <Box flexDirection="column">
          {title(s.summaryTitle)}
          <Text>
            {stat(s.averageHit, summary.averageHitRate === null ? '–' : formatPercent(summary.averageHitRate))} ·{' '}
            {stat(s.requests, String(summary.requests))} · {stat(s.breaks, String(summary.breaks))} ·{' '}
            {stat(s.extensionsCount, String(summary.extensions))} ·{' '}
            {stat(s.peakContext, formatTokens(summary.peakContext))}
          </Text>
        </Box>

        {Svg === null ? null : (
          <Box flexDirection="column">
            {title(s.chartTitle)}
            <Svg key="chart" alt={s.chartAlt} source={chartDrawing.source} height={chartDrawing.height} isInteractive />
            {/* What every chart has on one row; the occasional marks, when shown, on a second. */}
            <Box flexDirection="row" columnGap={2} rowGap={0} flexWrap="wrap">
              {/* Opaque swatches: the bars' see-through greys vanish as text. */}
              {swatch(COLORS.neutral, '■', s.legend.read)}
              {swatch(COLORS.written, '■', s.legend.written)}
              {swatch(COLORS.neutral, '□', s.legend.uncached)}
              <Text>
                <Text color={COLORS.neutral}>▬</Text>
                {chartMarks.dip ? <Text color={COLORS.dip}>▬</Text> : null}
                {chartMarks.low ? <Text color={COLORS.warn}>▬</Text> : null}
                <Text dimColor> {s.legend.rate}</Text>
              </Text>
            </Box>
            {chartMarks.broke || chartMarks.gap || chartMarks.extension ? (
              <Box flexDirection="row" columnGap={2} rowGap={0} flexWrap="wrap">
                {chartMarks.broke ? swatch(COLORS.alert, '▬', s.legend.broke) : null}
                {chartMarks.gap ? swatch(COLORS.neutral, '┊', s.legend.gap) : null}
                {chartMarks.extension ? swatch(COLORS.neutral, '▲', s.legend.extension) : null}
              </Box>
            ) : null}
          </Box>
        )}

        {/* Nothing to list: one line says so, rather than two empty sections. */}
        {breakList.length === 0 && extensionList.length === 0 ? (
          <Text dimColor>{s.quietHistory}</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              {title(s.breaksTitle)}
              {breakList.length === 0 ? <Text dimColor>{s.noBreaks}</Text> : null}
              {breakList
                .slice(-LIST_ROWS)
                .reverse()
                .map(b => (
                  <Box flexDirection="column">
                    <Text>
                      <Text color={TEXT_ALERT}>● </Text>
                      {s.breakLine(
                        numberOf(b.at),
                        formatPercent(b.previousHitRate),
                        formatPercent(b.hitRate),
                        formatTokens(b.rewritten),
                      )}
                    </Text>
                    <Text dimColor>  {formatCauses(b.causes, s)}</Text>
                  </Box>
                ))}
            </Box>

            <Box flexDirection="column">
              {title(s.extensionsTitle)}
              {extensionList.length === 0 ? <Text dimColor>{s.noExtensions}</Text> : null}
              {extensionList
                .slice(-LIST_ROWS)
                .reverse()
                .map(x => (
                  <Text>
                    <Text dimColor>{s.idleAt(formatClock(x.at - (idleSince(x.at) ?? x.at)))} · </Text>
                    {s.trigger[x.trigger]} ·{' '}
                    {x.isAnswered ? (
                      s.extensionRead(formatTokens(x.read))
                    ) : (
                      <Text color={TEXT_ALERT}>{s.extensionFailed(x.reason ?? '')}</Text>
                    )}
                  </Text>
                ))}
            </Box>
          </Box>
        )}

        {settings}
      </Box>
    )
  })

  // /clear starts a new conversation: its first request is a cold write, not a break.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, samples, () => [])
      await update($, breaks, () => [])
      await update($, extensions, () => [])
      await $.state.set({ ...changedAt, id: 'compact' }, null)
      await $.state.set({ ...changedAt, id: 'system' }, null)
      await $.state.set({ ...changedAt, id: 'tools' }, null)
    }

    return next(e)
  })
}
