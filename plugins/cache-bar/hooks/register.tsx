import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CacheBreak, CacheSample, Extension } from '../types'
import {
  EMPTY_TTL,
  MAX_EVENTS,
  MAX_SAMPLES,
  appendCapped,
  effectiveTtl,
  formatStatus,
  guessCauses,
  isBreak,
  isTtlState,
  learnTtl,
  notePrint,
  readConfig,
  toBreak,
  toSample,
} from './core'
import { STRINGS } from './i18n'

const samples = atom({ plugin: 'cache-bar', key: 'samples' } as const, [] as CacheSample[])
const breaks = atom({ plugin: 'cache-bar', key: 'breaks' } as const, [] as CacheBreak[])
const extensions = atom({ plugin: 'cache-bar', key: 'extensions' } as const, [] as Extension[])
const ttl = atom({ plugin: 'cache-bar', key: 'ttl' } as const, EMPTY_TTL)
// Families, one member per id: many hooks fire at once (tool.describe once per
// tool), and members never contend the way one shared value would.
const changedAt = { plugin: 'cache-bar', key: 'changedAt' } as const
const prints = { plugin: 'cache-bar', key: 'prints' } as const
const clock = atom({ plugin: 'cache-bar', key: 'now' } as const, 0)

/** `$.store` key of the learned TTL, kept across sessions. */
const TTL_STORE_KEY = 'ttl'

export const register: Register = (on, options) => {
  const config = readConfig(options)
  const strings = STRINGS[config.language]
  let shownStatus: string | undefined

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(TTL_STORE_KEY)

    if (isTtlState(stored)) {
      await update($, ttl, current => (current.detected === null ? stored : current))
    }

    // The clock goes through $.state: a value the drawings read redraws them.
    $.clock.every(1000, async () => {
      const now = await $.clock.now()
      await update($, clock, () => now)

      const text = formatStatus(
        {
          samples: await read($, samples),
          breaks: await read($, breaks),
          extensions: await read($, extensions),
          ttl: await read($, ttl),
          mode: config.ttlMode,
          now,
        },
        strings,
      )

      if (text !== shownStatus) {
        shownStatus = text
        $.ui.status(text)
      }
    })

    return next(e)
  })

  // Record each main-thread request's cache usage; judge breaks and the TTL.
  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const step = yield* next(e)

    if (e.agentId !== undefined || step.usage === null) {
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
      const causes = guessCauses(previous, sample, marks, effectiveTtl(config.ttlMode, learned))

      if (isBreak(previous, sample, config.breakSensitivity)) {
        await update($, breaks, list => appendCapped(list, toBreak(previous, sample, causes), MAX_EVENTS))
      }

      const relearned = learnTtl(learned, previous, sample, causes.filter(c => c !== 'idle'))

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
