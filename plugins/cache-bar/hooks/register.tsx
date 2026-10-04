import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CacheBreak, CacheSample, Extension } from '../types'
import {
  EMPTY_TTL,
  KEEP_WARM_PROMPT,
  MAX_EVENTS,
  MAX_SAMPLES,
  anchorOf,
  appendCapped,
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
  notePrint,
  readConfig,
  recentHits,
  shouldAutoExtend,
  toBreak,
  toExtension,
  toSample,
} from './core'
import { STRINGS } from './i18n'
import {
  COLORS,
  IDLE_RING_SVG,
  RING_SIZE,
  SPARK_HEIGHT,
  SPARK_WIDTH,
  SPINNER_SVG,
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
const extending = atom({ plugin: 'cache-bar', key: 'extending' } as const, false)
const alertedFor = atom({ plugin: 'cache-bar', key: 'alertedFor' } as const, null as number | null)

/** `$.store` key of the learned TTL, kept across sessions. */
const TTL_STORE_KEY = 'ttl'

/** Requests the band's trend line spans. */
const SPARK_POINTS = 24

export const register: Register = (on, options) => {
  const config = readConfig(options)
  const strings = STRINGS[config.language]
  let shownStatus: string | undefined
  // Once the desktop band draws, the status line would only repeat it.
  let hasBand = false
  let isWorking = false
  let isForking = false
  // Set by session.start: one keep-warm fork. The band's button calls it too,
  // since a Button can't reach this plugin's own slash command.
  let extendNow: ((trigger: Extension['trigger']) => Promise<void>) | null = null
  // The ring's drawing stays the same while its anchor, TTL and phase do, so
  // its SMIL countdown keeps running across the band's per-second redraws.
  let ring = { key: '', source: '' }

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(TTL_STORE_KEY)

    if (isTtlState(stored)) {
      await update($, ttl, current => (current.detected === null ? stored : current))
    }

    extendNow = async trigger => {
      if (isForking) {
        return
      }

      isForking = true
      await update($, extending, () => true)
      const sentAt = await $.clock.now()

      try {
        const outcome = await $.model.fork({ prompt: KEEP_WARM_PROMPT })
        const extension = toExtension(outcome, sentAt, trigger)
        await update($, extensions, list => appendCapped(list, extension, MAX_EVENTS))
        const readK = formatTokens(extension.read)

        if (!outcome.isAnswered) {
          $.ui.toast(strings.extendFailed(outcome.reason))
        } else if (trigger === 'manual') {
          $.ui.toast(strings.extended(readK))
        } else if (config.toast) {
          $.ui.toast(strings.autoExtended(readK))
        }
      } catch (err) {
        const reason = String(err)
        const extension = toExtension({ isAnswered: false, reason }, sentAt, trigger)
        await update($, extensions, list => appendCapped(list, extension, MAX_EVENTS))
        $.ui.toast(strings.extendFailed(reason))
      } finally {
        isForking = false
        await update($, extending, () => false)
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
        mode: config.ttlMode,
        now,
      }
      const text = hasBand ? undefined : formatStatus(view, strings)

      if (text !== shownStatus) {
        shownStatus = text
        $.ui.status(text)
      }

      // Expiry notices: none while Claude answers, since each request refreshes.
      const last = view.samples.at(-1)
      const countdown = countdownOf(view.samples, view.extensions, config.ttlMode, view.ttl, config, now)

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
        $.ui.toast(config.onExpiring === 'notify' ? notice : `${notice} · ${strings.pressExtend}`)
      }
    })

    return next(e)
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

  // The band above the prompt, desktop only: ring, clock, hit rate, context,
  // trend line, and the extend button once the cache is about to expire.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) {
      return next(e)
    }

    hasBand = true
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    // Read so the per-second tick redraws the band; the time itself comes fresh.
    await read($, clock)
    const now = await $.clock.now()
    const list = await read($, samples)
    const last = list.at(-1)
    const s = strings

    if (last === undefined) {
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg key="ring" alt={s.ringAlt} source={IDLE_RING_SVG} width={RING_SIZE} height={RING_SIZE} />
          <Text dimColor>{s.waiting}</Text>
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
      ring = { key: ringKey, source: isAnswering ? SPINNER_SVG : ringSvg(countdown) }
    }

    const lastBreak = breakList.at(-1)
    const didBreak = lastBreak !== undefined && lastBreak.at === last.sentAt
    const canExtend = !isAnswering && countdown.phase === 'alert' && config.onExpiring !== 'notify'
    const clockColor =
      countdown.phase === 'warn' ? COLORS.warn : countdown.phase === 'alert' ? COLORS.alert : undefined

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Svg key="ring" alt={s.ringAlt} source={ring.source} width={RING_SIZE} height={RING_SIZE} />
        {isAnswering ? (
          <Text color={COLORS.working}>{s.working}</Text>
        ) : countdown.phase === 'expired' ? (
          <Text color={COLORS.expired}>
            {s.expired} · {s.rewriteNext(context)}
          </Text>
        ) : (
          <Text bold color={clockColor}>
            {formatClock(countdown.leftMs)}
          </Text>
        )}
        <Text dimColor>{s.ttl(config.ttlMode, countdown.ttl)}</Text>
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
        {didBreak ? <Text color={COLORS.alert}>⚠ {s.broke(formatCauses(lastBreak.causes, s))}</Text> : null}
        {isExtending ? (
          <Text dimColor>{s.extending}</Text>
        ) : canExtend ? (
          <Button key="extend" variant="primary" label={s.extend(context)} onPress={() => void extendNow?.('manual')} />
        ) : null}
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
